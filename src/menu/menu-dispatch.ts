import { PLATFORM } from "../platform";
import menuSpec from "./menu-spec.json";

/**
 * #74 / #89: runs native menu actions through the same handlers as the keyboard
 * shortcuts, and makes sure one key press runs a command once.
 *
 * WKWebView (and WebView2 on Windows) offers a key equivalent to the page
 * first; the menu only gets it when the page did not call preventDefault.
 * Depending on the WebView build (and on whether a menu accelerator wins), a
 * shortcut can therefore reach the app as a keydown, as a menu event, or — in
 * theory — both. The guard:
 *  - a menu event whose accelerator matches the last keydown, which the page
 *    already handled (defaultPrevented) moments ago, is dropped;
 *  - a keydown matching the accelerator of a menu action that just ran is
 *    swallowed before any other listener sees it.
 * Each guard consumes its record, so key repeat cannot chain them.
 */

export type MenuPlatform = "macos" | "windows" | "linux";

export type MenuNode =
  | {
      type: "submenu";
      labelKey: string;
      role?: "app" | "window" | "help";
      platforms?: MenuPlatform[];
      items: MenuNode[];
    }
  | {
      type: "themes";
      labelKey: string;
      platforms?: MenuPlatform[];
      items: MenuNode[];
    }
  | {
      type: "recentFiles";
      labelKey: string;
      platforms?: MenuPlatform[];
      items: MenuNode[];
    }
  | {
      type: "action";
      id: string;
      labelKey: string;
      accel?: string;
      check?: boolean;
      platforms?: MenuPlatform[];
    }
  | {
      type: "predefined";
      item: string;
      labelKey?: string;
      platforms?: MenuPlatform[];
    }
  | {
      type: "link";
      id: string;
      labelKey: string;
      url: string;
      platforms?: MenuPlatform[];
    };

export const MENU_SPEC = menuSpec as MenuNode[];

export function currentMenuPlatform(): MenuPlatform {
  if (PLATFORM === "windows") return "windows";
  if (PLATFORM === "linux") return "linux";
  return "macos";
}

/** Filters `spec` to the items that belong on `platform` (matches Rust `filter_menu_spec`). */
export function filterMenuSpec(
  spec: MenuNode[],
  platform: MenuPlatform,
): MenuNode[] {
  const out: MenuNode[] = [];
  for (const node of spec) {
    if (node.platforms && !node.platforms.includes(platform)) continue;
    if (node.type === "submenu") {
      out.push({ ...node, items: filterMenuSpec(node.items, platform) });
    } else if (node.type === "themes") {
      out.push({ ...node, items: filterMenuSpec(node.items, platform) });
    } else if (node.type === "recentFiles") {
      out.push({ ...node, items: filterMenuSpec(node.items, platform) });
    } else {
      out.push(node);
    }
  }
  return out;
}

export function menuSpecFor(
  platform: MenuPlatform = currentMenuPlatform(),
): MenuNode[] {
  return filterMenuSpec(MENU_SPEC, platform);
}

/** Formats a Tauri accelerator ("CmdOrCtrl+Shift+S") for display on `platform`. */
export function formatAccelerator(
  accel: string,
  platform: MenuPlatform = currentMenuPlatform(),
): string {
  const parts = accel.split("+").map((p) => p.trim());
  const keyPart = parts.pop() ?? "";
  const isMac = platform === "macos";
  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  for (const raw of parts) {
    const modifier = raw.toLowerCase();
    if (modifier === "cmdorctrl" || modifier === "commandorcontrol") {
      if (isMac) meta = true;
      else ctrl = true;
    } else if (
      modifier === "cmd" ||
      modifier === "command" ||
      modifier === "super" ||
      modifier === "meta"
    ) {
      meta = true;
    } else if (modifier === "ctrl" || modifier === "control") {
      ctrl = true;
    } else if (modifier === "alt" || modifier === "option") {
      alt = true;
    } else if (modifier === "shift") {
      shift = true;
    }
  }
  if (isMac) {
    const mods = `${ctrl ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${meta ? "⌘" : ""}`;
    const macKeys: Record<string, string> = {
      tab: "⇥",
      backspace: "⌫",
      enter: "↩",
      escape: "Esc",
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
    };
    const key = macKeys[keyPart.toLowerCase()] ?? keyPart;
    return `${mods}${key}`;
  }
  const mods: string[] = [];
  if (ctrl) mods.push("Ctrl");
  if (meta) mods.push("Win");
  if (alt) mods.push("Alt");
  if (shift) mods.push("Shift");
  const winKeys: Record<string, string> = {
    tab: "Tab",
    backspace: "Backspace",
    enter: "Enter",
    escape: "Esc",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
  };
  const key = winKeys[keyPart.toLowerCase()] ?? keyPart;
  return [...mods, key].join("+");
}

/** Generated per theme by the Rust side; carries the theme id as `arg`. */
export const SET_THEME_ACTION = "view.setTheme";
/** #104: generated per recent file by the Rust side; carries the file path as `arg`. */
export const OPEN_RECENT_ACTION = "file.openRecent";
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
  labelKey: string;
  accel?: string;
  check?: boolean;
}

export function menuActions(
  spec: MenuNode[] = menuSpecFor(),
): MenuActionNode[] {
  const out: MenuActionNode[] = [];
  const walk = (nodes: MenuNode[]) => {
    for (const node of nodes) {
      if (node.type === "action") out.push(node);
      else if (
        node.type === "submenu" ||
        node.type === "themes" ||
        node.type === "recentFiles"
      )
        walk(node.items);
    }
  };
  walk(spec);
  return out;
}

export interface KeyMatcher {
  code?: string;
  key?: string;
  /** CmdOrCtrl: exactly one of Cmd / Ctrl. A bare Ctrl (⌃⇥) needs Ctrl without Cmd. */
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
  const m: KeyMatcher = {
    cmdOrCtrl: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
  };
  for (const raw of parts) {
    const token = raw.trim().toLowerCase();
    if (token === "cmdorctrl" || token === "commandorcontrol") {
      m.cmdOrCtrl = true;
    } else if (
      token === "cmd" ||
      token === "command" ||
      token === "super" ||
      token === "meta"
    ) {
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
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(keyToken))
    m.key = keyToken.toUpperCase();
  else if (SYMBOL_CODES[keyToken]) m.code = SYMBOL_CODES[keyToken];
  else if (keyToken.toLowerCase() === "tab") m.code = "Tab";
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

export function createMenuDispatcher(
  options: MenuDispatcherOptions,
): MenuDispatcher {
  const { commands, target } = options;
  const now = options.now ?? (() => Date.now());
  const matchers = new Map<string, KeyMatcher>();
  for (const node of menuActions(options.spec ?? menuSpecFor())) {
    if (node.accel) matchers.set(node.id, parseAccelerator(node.accel));
  }

  let lastKey: { event: KeyboardEvent; at: number } | null = null;
  let lastMenuRun: { matcher: KeyMatcher; at: number } | null = null;

  const onKeydownCapture = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (
      lastMenuRun &&
      now() - lastMenuRun.at <= MENU_THEN_KEY_WINDOW_MS &&
      matchesKey(lastMenuRun.matcher, event)
    ) {
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
        void (result as Promise<unknown>)
          .catch(() => null)
          .then(() => options.afterRun?.(action));
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
    destroy: () =>
      target.removeEventListener("keydown", onKeydownCapture, true),
  };
}
