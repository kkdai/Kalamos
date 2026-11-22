import "./table-toolbar.css";

import {
  type EditorState,
  type Extension,
  StateField,
} from "@codemirror/state";
import type {
  DecorationSet,
  KeyBinding,
  PluginValue,
  ViewUpdate,
} from "@codemirror/view";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { shortcutLabel } from "../platform";
import {
  type ActiveTableCell,
  columnAlign,
  getActiveTableCell,
  runTableAction,
  type TableAction,
} from "./table-ops";
import { findTableAtPos } from "./tables";

/**
 * #59 B: floating table toolbar + context menu + shortcuts.
 *
 * The toolbar is positioned by a ViewPlugin inside the editor's scroller; it
 * is never part of the table widget's DOM, so widget rebuilds don't touch it.
 * It must never cover text: while a table is active a StateField puts an
 * empty block widget (the spacer) right before it, and the toolbar sits in
 * that reserved space. When the spacer appears / disappears the scroll
 * position is compensated so the cell being edited doesn't move on screen.
 */

// ---------------------------------------------------------------------------
// Spacer reserving room above the active table
// ---------------------------------------------------------------------------

/** Height of the reserved space (toolbar ≈ 32 px + 3 px above and below). */
export const TABLE_TOOLBAR_SPACE = 38;

class ToolbarSpacerWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "k-table-toolbar-spacer";
    el.style.height = `${TABLE_TOOLBAR_SPACE}px`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  get estimatedHeight(): number {
    return TABLE_TOOLBAR_SPACE;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

interface ActiveTableRange {
  from: number;
  to: number;
  decorations: DecorationSet;
}

function activeTableRange(state: EditorState): ActiveTableRange | null {
  const active = getActiveTableCell(state);
  if (!active) return null;
  const { from, to } = active.table;
  return {
    from,
    to,
    // After the line before the table rather than at the table's start: a
    // decoration change touching the table's range makes CodeMirror rebuild
    // the table widget's DOM (losing the focused cell).
    decorations: Decoration.set([
      from > 0
        ? Decoration.widget({
            widget: new ToolbarSpacerWidget(),
            block: true,
            side: 1,
          }).range(from - 1)
        : Decoration.widget({
            widget: new ToolbarSpacerWidget(),
            block: true,
            side: -1,
          }).range(from),
    ]),
  };
}

/** The active table's range plus the spacer before it (block decorations need a StateField). */
export const tableToolbarSpaceField =
  StateField.define<ActiveTableRange | null>({
    create: activeTableRange,
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      const next = activeTableRange(tr.state);
      if (
        next &&
        value &&
        !tr.docChanged &&
        next.from === value.from &&
        next.to === value.to
      )
        return value;
      return next;
    },
    provide: (f) =>
      EditorView.decorations.from(f, (v) => v?.decorations ?? Decoration.none),
  });

/** The `.k-table-wrapper` of the table starting at `pos` (current DOM). */
function tableWrapperAt(view: EditorView, pos: number): HTMLElement | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(
    ".k-table-wrapper",
  )) {
    try {
      if (view.posAtDOM(el) === pos) return el;
    } catch {
      // not in the document view
    }
  }
  return null;
}

interface ShortcutSpec {
  key: string;
  action: TableAction;
  /** `event.code` + modifiers for events CodeMirror ignores (focused widget cells). */
  code: string;
  alt: boolean;
  shift: boolean;
}

/**
 * Table shortcuts (only inside a table; elsewhere the key falls through).
 * Cmd+Enter is reserved for leaving the table (#59 A).
 */
export const TABLE_SHORTCUTS: readonly ShortcutSpec[] = [
  {
    key: "Mod-Alt-ArrowUp",
    action: "rowAbove",
    code: "ArrowUp",
    alt: true,
    shift: false,
  },
  {
    key: "Mod-Alt-ArrowDown",
    action: "rowBelow",
    code: "ArrowDown",
    alt: true,
    shift: false,
  },
  {
    key: "Mod-Alt-ArrowLeft",
    action: "colLeft",
    code: "ArrowLeft",
    alt: true,
    shift: false,
  },
  {
    key: "Mod-Alt-ArrowRight",
    action: "colRight",
    code: "ArrowRight",
    alt: true,
    shift: false,
  },
  {
    key: "Mod-Shift-Backspace",
    action: "deleteRow",
    code: "Backspace",
    alt: false,
    shift: true,
  },
  {
    key: "Mod-Alt-Backspace",
    action: "deleteCol",
    code: "Backspace",
    alt: true,
    shift: false,
  },
  // Not L / C / R: Cmd+Opt+(Shift+)R is the image root folder (IM-04).
  {
    key: "Mod-Alt-Shift-ArrowLeft",
    action: "alignLeft",
    code: "ArrowLeft",
    alt: true,
    shift: true,
  },
  {
    key: "Mod-Alt-Shift-ArrowUp",
    action: "alignCenter",
    code: "ArrowUp",
    alt: true,
    shift: true,
  },
  {
    key: "Mod-Alt-Shift-ArrowRight",
    action: "alignRight",
    code: "ArrowRight",
    alt: true,
    shift: true,
  },
];

/**
 * Bindings for the editor keymap (cursor in the table source / cells). No
 * `preventDefault: true`: outside tables the key must reach other handlers.
 */
export const tableKeymap: KeyBinding[] = TABLE_SHORTCUTS.map((s) => ({
  key: s.key,
  run: (view: EditorView) => {
    const target = getActiveTableCell(view.state);
    if (!target) return false;
    runTableAction(view, s.action, target);
    return true; // swallow inside tables even when the op is a no-op
  },
}));

export function shortcutActionForEvent(
  event: KeyboardEvent,
): TableAction | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const spec = TABLE_SHORTCUTS.find(
    (s) =>
      s.code === event.code &&
      s.alt === event.altKey &&
      s.shift === event.shiftKey,
  );
  return spec?.action ?? null;
}

/** The cell a DOM node of a table widget belongs to (`th/td[data-row][data-col]`). */
export function tableCellFromDom(
  view: EditorView,
  node: Node | null,
): ActiveTableCell | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const cellEl = el?.closest<HTMLElement>("[data-row][data-col]");
  const wrapper = cellEl?.closest<HTMLElement>(".k-table-wrapper");
  if (!cellEl || !wrapper || !view.contentDOM.contains(wrapper)) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(wrapper);
  } catch {
    return null;
  }
  const table = findTableAtPos(view.state, pos);
  if (!table) return null;
  const row = Number(cellEl.dataset.row);
  const col = Number(cellEl.dataset.col);
  if (
    !(
      row >= 0 &&
      row <= table.bodyRows.length &&
      col >= 0 &&
      col < table.colCount
    )
  )
    return null;
  return { table, row, col };
}

/** The table cell being edited: a focused widget cell, else the cursor's cell. */
export function currentTableCell(view: EditorView): ActiveTableCell | null {
  const active = view.dom.ownerDocument.activeElement;
  if (
    active &&
    active !== view.contentDOM &&
    view.contentDOM.contains(active)
  ) {
    const fromDom = tableCellFromDom(view, active);
    if (fromDom) return fromDom;
  }
  return getActiveTableCell(view.state);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function alignIcon(
  doc: Document,
  kind: "left" | "center" | "right",
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("aria-hidden", "true");
  const lines: Array<[number, number]> =
    kind === "left"
      ? [
          [2, 12],
          [2, 8],
          [2, 12],
          [2, 8],
        ]
      : kind === "right"
        ? [
            [2, 12],
            [6, 12],
            [2, 12],
            [6, 12],
          ]
        : [
            [2, 12],
            [4, 10],
            [2, 12],
            [4, 10],
          ];
  lines.forEach(([x1, x2], i) => {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M${x1} ${2.5 + i * 3}H${x2}`);
    svg.append(path);
  });
  return svg;
}

interface ButtonSpec {
  action: TableAction;
  label: string;
  title: string;
  icon?: "left" | "center" | "right";
}

const TOOLBAR_GROUPS: ButtonSpec[][] = [
  [
    {
      action: "alignLeft",
      label: "靠左",
      title: "欄靠左（⌥⇧⌘←）",
      icon: "left",
    },
    {
      action: "alignCenter",
      label: "置中",
      title: "欄置中（⌥⇧⌘↑）",
      icon: "center",
    },
    {
      action: "alignRight",
      label: "靠右",
      title: "欄靠右（⌥⇧⌘→）",
      icon: "right",
    },
  ],
  [
    { action: "rowBelow", label: "+列", title: "下方插入列（⌥⌘↓）" },
    { action: "colRight", label: "+欄", title: "右側插入欄（⌥⌘→）" },
  ],
  [
    { action: "deleteRow", label: "−列", title: "刪除列（⇧⌘⌫）" },
    { action: "deleteCol", label: "−欄", title: "刪除欄（⌥⌘⌫）" },
    { action: "deleteTable", label: "刪表", title: "刪除表格" },
  ],
];

interface MenuItemSpec {
  action: TableAction;
  label: string;
  shortcut?: string;
}

const MENU_GROUPS: MenuItemSpec[][] = [
  [
    { action: "rowAbove", label: "上方插入列", shortcut: "⌥⌘↑" },
    { action: "rowBelow", label: "下方插入列", shortcut: "⌥⌘↓" },
    { action: "colLeft", label: "左側插入欄", shortcut: "⌥⌘←" },
    { action: "colRight", label: "右側插入欄", shortcut: "⌥⌘→" },
  ],
  [
    { action: "alignLeft", label: "欄靠左", shortcut: "⌥⇧⌘←" },
    { action: "alignCenter", label: "欄置中", shortcut: "⌥⇧⌘↑" },
    { action: "alignRight", label: "欄靠右", shortcut: "⌥⇧⌘→" },
    { action: "moveColLeft", label: "欄左移" },
    { action: "moveColRight", label: "欄右移" },
  ],
  [
    { action: "deleteRow", label: "刪除列", shortcut: "⇧⌘⌫" },
    { action: "deleteCol", label: "刪除欄", shortcut: "⌥⌘⌫" },
    { action: "deleteTable", label: "刪除表格" },
  ],
];

function isActionDisabled(action: TableAction, cell: ActiveTableCell): boolean {
  if (action === "deleteRow") return cell.row === 0;
  if (action === "moveColLeft") return cell.col === 0;
  if (action === "moveColRight") return cell.col >= cell.table.colCount - 1;
  return false;
}

function isAlignPressed(
  action: TableAction,
  cell: ActiveTableCell,
): boolean | null {
  const align = columnAlign(cell.table, cell.col);
  if (action === "alignLeft") return align === "left";
  if (action === "alignCenter") return align === "center";
  if (action === "alignRight") return align === "right";
  return null;
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

let openMenuCleanup: (() => void) | null = null;

export function closeTableContextMenu(): void {
  openMenuCleanup?.();
}

export function openTableContextMenu(
  view: EditorView,
  target: ActiveTableCell,
  x: number,
  y: number,
): HTMLElement {
  closeTableContextMenu();
  const doc = view.dom.ownerDocument;
  // Escape gives focus back to where it was (a cell, or the editor).
  const previousFocus =
    doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const restoreFocus = () => {
    if (previousFocus?.isConnected && previousFocus !== doc.body)
      previousFocus.focus({ preventScroll: true });
    else view.focus();
  };
  const menu = doc.createElement("div");
  menu.className = "k-table-menu";
  menu.dataset.testid = "table-context-menu";
  menu.setAttribute("role", "menu");

  const items: HTMLButtonElement[] = [];
  MENU_GROUPS.forEach((group, gi) => {
    if (gi > 0) {
      const sep = doc.createElement("div");
      sep.className = "k-table-menu-sep";
      sep.setAttribute("role", "separator");
      menu.append(sep);
    }
    for (const spec of group) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "k-table-menu-item";
      item.setAttribute("role", "menuitem");
      item.dataset.action = spec.action;
      const label = doc.createElement("span");
      label.textContent = spec.label;
      item.append(label);
      if (spec.shortcut) {
        const kbd = doc.createElement("span");
        kbd.className = "k-table-menu-shortcut";
        kbd.textContent = shortcutLabel(spec.shortcut);
        item.append(kbd);
      }
      item.disabled = isActionDisabled(spec.action, target);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        close();
        // applyTableOp focuses the target cell; a no-op leaves focus as it was.
        if (!runTableAction(view, spec.action, target)) restoreFocus();
      });
      items.push(item);
      menu.append(item);
    }
  });

  const onDocMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      restoreFocus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = items.filter((i) => !i.disabled);
      const idx = enabled.indexOf(doc.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(idx + step + enabled.length) % enabled.length]?.focus();
    }
  };
  const onBlur = () => close();
  function close() {
    if (openMenuCleanup !== close) return;
    openMenuCleanup = null;
    doc.removeEventListener("mousedown", onDocMouseDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.defaultView?.removeEventListener("blur", onBlur);
    view.scrollDOM.removeEventListener("scroll", onBlur);
    menu.remove();
  }
  openMenuCleanup = close;
  doc.addEventListener("mousedown", onDocMouseDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.defaultView?.addEventListener("blur", onBlur);
  view.scrollDOM.addEventListener("scroll", onBlur);

  doc.body.append(menu);
  // Keep the menu inside the window.
  const rect = menu.getBoundingClientRect();
  const win = doc.defaultView;
  const maxX = (win?.innerWidth ?? 0) - rect.width - 4;
  const maxY = (win?.innerHeight ?? 0) - rect.height - 4;
  menu.style.left = `${Math.max(4, maxX > 0 ? Math.min(x, maxX) : x)}px`;
  menu.style.top = `${Math.max(4, maxY > 0 ? Math.min(y, maxY) : y)}px`;
  return menu;
}

/** The table cell under a context-menu event (widget cell, or table source). */
function tableCellForEvent(
  view: EditorView,
  event: MouseEvent,
): ActiveTableCell | null {
  const fromDom = tableCellFromDom(view, event.target as Node | null);
  if (fromDom) return fromDom;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const table = findTableAtPos(view.state, pos);
  if (!table || pos < table.from || pos > table.to) return null;
  // Same location rules as the cursor.
  const probe = view.state.update({ selection: { anchor: pos } }).state;
  return getActiveTableCell(probe);
}

// ---------------------------------------------------------------------------
// Toolbar plugin
// ---------------------------------------------------------------------------

class TableToolbarView implements PluginValue {
  readonly dom: HTMLElement;
  private readonly buttons = new Map<TableAction, HTMLButtonElement>();
  private target: ActiveTableCell | null = null;
  private readonly onContextMenu: (e: MouseEvent) => void;
  private readonly onMouseDown: (e: MouseEvent) => void;
  /** Cell under the last right-button press (the layout may shift before contextmenu). */
  private rightPressCell: ActiveTableCell | null = null;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onFocusChange: () => void;

  constructor(private readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement("div");
    this.dom.className = "k-table-toolbar";
    this.dom.dataset.testid = "table-toolbar";
    this.dom.setAttribute("role", "toolbar");
    this.dom.setAttribute("aria-label", "表格");
    this.dom.hidden = true;
    TOOLBAR_GROUPS.forEach((group, gi) => {
      if (gi > 0) {
        const sep = doc.createElement("span");
        sep.className = "k-table-toolbar-sep";
        this.dom.append(sep);
      }
      for (const spec of group) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "k-table-toolbar-btn";
        btn.dataset.action = spec.action;
        btn.title = shortcutLabel(spec.title);
        btn.setAttribute("aria-label", spec.label);
        if (spec.icon) btn.append(alignIcon(doc, spec.icon));
        else btn.textContent = spec.label;
        if (spec.action === "deleteTable") btn.classList.add("is-danger");
        this.buttons.set(spec.action, btn);
        this.dom.append(btn);
      }
    });
    // Keep the editor / focused cell focused while clicking the toolbar.
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    this.dom.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-action]",
      );
      if (!btn || btn.disabled) return;
      const target = currentTableCell(this.view) ?? this.target;
      if (!target) return;
      runTableAction(this.view, btn.dataset.action as TableAction, target);
    });
    view.scrollDOM.append(this.dom);

    this.onContextMenu = (e) => {
      const target = this.rightPressCell ?? tableCellForEvent(this.view, e);
      this.rightPressCell = null;
      if (!target) return;
      e.preventDefault();
      openTableContextMenu(this.view, target, e.clientX, e.clientY);
    };
    // A right-button press on a rendered cell would move the DOM selection
    // into the table (switching it to source); the context menu still opens.
    this.onMouseDown = (e) => {
      if (e.button !== 2) {
        this.rightPressCell = null;
        return;
      }
      const el = e.target instanceof Element ? e.target : null;
      this.rightPressCell = tableCellFromDom(this.view, el);
      if (el?.closest(".k-table-wrapper [data-row][data-col]"))
        e.preventDefault();
    };
    // Shortcuts typed in a focused widget cell (CodeMirror ignores those events).
    this.onKeyDown = (e) => {
      if (e.defaultPrevented) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest(".k-table-wrapper")) return;
      const action = shortcutActionForEvent(e);
      if (!action) return;
      const target = tableCellFromDom(this.view, el);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      runTableAction(this.view, action, target);
    };
    this.onFocusChange = () => this.schedule();
    view.contentDOM.addEventListener("contextmenu", this.onContextMenu);
    view.contentDOM.addEventListener("mousedown", this.onMouseDown, true);
    view.contentDOM.addEventListener("keydown", this.onKeyDown);
    view.contentDOM.addEventListener("focusin", this.onFocusChange);
    view.contentDOM.addEventListener("focusout", this.onFocusChange);
    this.schedule();
  }

  /** Element whose screen position must not change across a spacer toggle. */
  anchor: { pos: number; top: number } | null = null;

  /**
   * Called right after the DOM update (update listener): scroll by however
   * far the anchor moved, before any later event (e.g. the contextmenu that
   * follows a right-button mousedown) sees the shifted layout.
   */
  compensateScroll(): void {
    const anchor = this.anchor;
    this.anchor = null;
    // The table widget's DOM may have been rebuilt: look the wrapper up again.
    const el = anchor && tableWrapperAt(this.view, anchor.pos);
    if (!anchor || !el) return;
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (delta) this.view.scrollDOM.scrollTop += delta;
  }

  update(update: ViewUpdate): void {
    const prev = update.startState.field(tableToolbarSpaceField, false) ?? null;
    const next = update.state.field(tableToolbarSpaceField, false) ?? null;
    const mappedPrev =
      prev && update.docChanged
        ? update.changes.mapPos(prev.from, -1)
        : prev?.from;
    if (
      (prev?.from ?? null) !== (next?.from ?? null) &&
      mappedPrev !== next?.from
    ) {
      // Plugins update before the DOM does: remember where the anchor is now.
      // Entering a table keeps that table still; leaving one keeps the text
      // below it still when the cursor went there.
      // `pos` is the wrapper's position after the update.
      let el: HTMLElement | null = null;
      let pos = 0;
      if (next) {
        const oldPos = update.docChanged
          ? update.changes.invertedDesc.mapPos(next.from, 1)
          : next.from;
        el = tableWrapperAt(update.view, oldPos);
        pos = next.from;
      } else if (prev && update.state.selection.main.head > mappedPrev!) {
        el = tableWrapperAt(update.view, prev.from);
        pos = mappedPrev!;
      }
      this.anchor = el ? { pos, top: el.getBoundingClientRect().top } : null;
    }
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.viewportChanged ||
      update.focusChanged
    ) {
      this.schedule();
    }
  }

  private schedule(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const spacer = view.contentDOM.querySelector<HTMLElement>(
          ".k-table-toolbar-spacer",
        );
        const target = spacer ? currentTableCell(view) : null;
        if (!spacer || !target) return { place: null };
        const scroller = view.scrollDOM;
        const scrollRect = scroller.getBoundingClientRect();
        const rect = spacer.getBoundingClientRect();
        const height = this.dom.offsetHeight || 32;
        return {
          place: {
            target,
            // Scroller content coordinates (independent of the scroll position).
            top:
              rect.top -
              scrollRect.top +
              scroller.scrollTop +
              Math.max(0, (rect.height - height) / 2),
            left: rect.left - scrollRect.left + scroller.scrollLeft,
          },
        };
      },
      write: ({ place }) => {
        this.target = place?.target ?? null;
        if (!place) {
          this.dom.hidden = true;
          return;
        }
        this.refreshButtons(place.target);
        this.dom.style.top = `${Math.round(place.top)}px`;
        this.dom.style.left = `${Math.round(place.left)}px`;
        this.dom.hidden = false;
      },
    });
  }

  private refreshButtons(target: ActiveTableCell): void {
    for (const [action, btn] of this.buttons) {
      btn.disabled = isActionDisabled(action, target);
      const pressed = isAlignPressed(action, target);
      if (pressed !== null) btn.setAttribute("aria-pressed", String(pressed));
    }
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("contextmenu", this.onContextMenu);
    this.view.contentDOM.removeEventListener(
      "mousedown",
      this.onMouseDown,
      true,
    );
    this.view.contentDOM.removeEventListener("keydown", this.onKeyDown);
    this.view.contentDOM.removeEventListener("focusin", this.onFocusChange);
    this.view.contentDOM.removeEventListener("focusout", this.onFocusChange);
    this.dom.remove();
    closeTableContextMenu();
  }
}

/** Floating toolbar + context menu; live-preview only (source mode unloads it). */
const tableToolbarPlugin = ViewPlugin.fromClass(TableToolbarView);

export const tableToolbarExtension: Extension = [
  tableToolbarSpaceField,
  tableToolbarPlugin,
  EditorView.updateListener.of((update) => {
    update.view.plugin(tableToolbarPlugin)?.compensateScroll();
  }),
];
