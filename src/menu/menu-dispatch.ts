import menuSpec from "./menu-spec.json";

/**
 * #74: runs native menu actions through the same handlers as the keyboard
 * shortcuts, and makes sure one key press runs a command once.
 *
 * WKWebView offers a key equivalent to the page first; the menu only gets it
 * when the page did not call preventDefault. Depending on the WebKit build
 * (and on whether a menu accelerator wins), a shortcut can therefore reach
 * the app as a keydown, as a menu event, or — in theory — both. The guard:
 *  - a menu event whose accelerator matches the last keydown, which the page
 *    already handled (defaultPrevented) moments ago, is dropped;
 *  - a keydown matching the accelerator of a menu action that just ran is
 *    swallowed before any other listener sees it.
 * Each guard consumes its record, so key repeat cannot chain them.
 */

export type MenuNode =
  | { type: "submenu"; label: string; role?: "app" | "window" | "help"; items: MenuNode[] }
  | { type: "themes"; label: string; items: MenuNode[] }
  | { type: "action"; id: string; label: string; accel?: string; check?: boolean }
  | { type: "predefined"; item: string; label?: string }
  | { type: "link"; id: string; label: string; url: string };

export const MENU_SPEC = menuSpec as MenuNode[];
/** Generated per theme by the Rust side; carries the theme id as `arg`. */
export const SET_THEME_ACTION = "view.setTheme";
/** A menu event this soon after a handled keydown of the same shortcut is that key press. */
export const DUPLICATE_WINDOW_MS = 500;
/**
 * A keydown this soon after the menu ran its shortcut is the same press. Kept
 * short: neither WebKit ordering delivers the keydown after the menu, so this
 * only backs up the guard above, and a real press right after a mouse click on
 * the menu must still work.
 */
export const MENU_THEN_KEY_WINDOW_MS = 150;

export interface MenuActionNode {
  id: string;
  label: string;
  accel?: string;
  check?: boolean;
}

export function menuActions(spec: MenuNode[] = MENU_SPEC): MenuActionNode[] {
  const out: MenuActionNode[] = [];
  const walk = (nodes: MenuNode[]) => {
    for (const node of nodes) {
      if (node.type === "action") out.push(node);
      else if (node.type === "submenu" || node.type === "themes") walk(node.items);
    }
  };
  walk(spec);
  return out;
}

export interface KeyMatcher {
  code?: string;
  key?: string;
  /** CmdOrCtrl: exactly one of Cmd / Ctrl (no accelerator in the spec uses a bare Ctrl). */
  cmdOrCtrl: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const SYMBOL_CODES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "=": "Equal",
  "-": "Minus",
  ";": "Semicolon",
  "'": "Quote",
  "\\": "Backslash",
};

/** Parses a Tauri accelerator ("CmdOrCtrl+Shift+S", "F8") into a keydown matcher. */
export function parseAccelerator(accel: string): KeyMatcher {
  const parts = accel.split("+");
  const keyToken = parts.pop() ?? "";
  const m: KeyMatcher = { cmdOrCtrl: false, meta: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const token = raw.trim().toLowerCase();
    if (token === "cmdorctrl" || token === "commandorcontrol") {
      m.cmdOrCtrl = true;
    } else if (token === "cmd" || token === "command" || token === "super" || token === "meta") {
      m.meta = true;
    } else if (token === "ctrl" || token === "control") {
      m.ctrl = true;
    } else if (token === "alt" || token === "option") {
      m.alt = true;
    } else if (token === "shift") {
      m.shift = true;
    } else {
      throw new Error(`Unknown accelerator modifier "${raw}" in ${accel}`);
    }
  }
  if (/^[a-z]$/i.test(keyToken)) m.code = `Key${keyToken.toUpperCase()}`;
  else if (/^[0-9]$/.test(keyToken)) m.code = `Digit${keyToken}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(keyToken)) m.key = keyToken.toUpperCase();
  else if (SYMBOL_CODES[keyToken]) m.code = SYMBOL_CODES[keyToken];
  else throw new Error(`Unknown accelerator key "${keyToken}" in ${accel}`);
  return m;
}

export function matchesKey(m: KeyMatcher, e: KeyboardEvent): boolean {
  if (e.altKey !== m.alt || e.shiftKey !== m.shift) return false;
  if (m.cmdOrCtrl) {
    if (e.metaKey === e.ctrlKey) return false;
  } else if (e.metaKey !== m.meta || e.ctrlKey !== m.ctrl) {
    return false;
  }
  if (m.key) return e.key === m.key;
  return e.code === m.code;
}

export type MenuCommand = (arg?: string | null) => unknown;

export interface MenuDispatcherOptions {
  commands: Record<string, MenuCommand>;
  /** Where keydowns are watched (capture phase, before every other listener). */
  target: Window | Document | HTMLElement;
  spec?: MenuNode[];
  now?: () => number;
  /** Return false to ignore an action (e.g. editing commands while a dialog is open). */
  canRun?: (action: string) => boolean;
  /** Called after an action ran (menu check states may have changed). */
  afterRun?: (action: string) => void;
}

export interface MenuDispatcher {
  /** Runs a menu action; false when it was a duplicate, unknown or blocked. */
  dispatch: (action: string, arg?: string | null) => boolean;
  hasCommand: (action: string) => boolean;
  destroy: () => void;
}

export function createMenuDispatcher(options: MenuDispatcherOptions): MenuDispatcher {
  const { commands, target } = options;
  const now = options.now ?? (() => Date.now());
  const matchers = new Map<string, KeyMatcher>();
  for (const node of menuActions(options.spec ?? MENU_SPEC)) {
    if (node.accel) matchers.set(node.id, parseAccelerator(node.accel));
  }

  let lastKey: { event: KeyboardEvent; at: number } | null = null;
  let lastMenuRun: { matcher: KeyMatcher; at: number } | null = null;

  const onKeydownCapture = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (lastMenuRun && now() - lastMenuRun.at <= MENU_THEN_KEY_WINDOW_MS && matchesKey(lastMenuRun.matcher, event)) {
      // The menu already ran this shortcut.
      lastMenuRun = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    lastKey = { event, at: now() };
  };
  target.addEventListener("keydown", onKeydownCapture, true);

  function dispatch(action: string, arg?: string | null): boolean {
    const command = commands[action];
    if (!command) return false;
    const matcher = matchers.get(action);
    if (
      matcher &&
      lastKey &&
      now() - lastKey.at <= DUPLICATE_WINDOW_MS &&
      lastKey.event.defaultPrevented &&
      matchesKey(matcher, lastKey.event)
    ) {
      // The page's own shortcut handler already ran for this key press.
      lastKey = null;
      return false;
    }
    if (options.canRun && !options.canRun(action)) return false;
    if (matcher) lastMenuRun = { matcher, at: now() };
    try {
      const result = command(arg);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).catch(() => null).then(() => options.afterRun?.(action));
      } else {
        options.afterRun?.(action);
      }
    } catch {
      options.afterRun?.(action);
    }
    return true;
  }

  return {
    dispatch,
    hasCommand: (action) => action in commands,
    destroy: () => target.removeEventListener("keydown", onKeydownCapture, true),
  };
}
