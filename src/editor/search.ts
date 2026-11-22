/**
 * #73 A: find & replace in the current document.
 *
 * Built on @codemirror/search (SearchQuery, findNext, findPrevious,
 * replaceNext, replaceAll, the search state and its match highlighter) with a
 * Kalamos panel instead of CodeMirror's default one:
 *
 * - Cmd+F opens the find bar (the selection, if any, becomes the query);
 *   Cmd+Opt+F opens find + replace; Cmd+G / Enter and Cmd+Shift+G /
 *   Shift+Enter go to the next / previous hit; Cmd+E uses the selection as the
 *   query; Esc closes the bar and gives focus back to the editor.
 * - Case / whole word / regex options, a "3 / 12" counter, "無結果", and an
 *   inline hint for an invalid regex (never throws).
 * - Live preview: a hit inside hidden markup is revealed by moving the
 *   selection there; a hit inside a table cell is highlighted inside the
 *   table widget and, when the editor has focus (or on Esc), the cell is
 *   focused with `focusTableCell` and the hit selected.
 * - IME: nothing is searched while the query is being composed.
 */
import "./search.css";

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  type Panel,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  cellRawToDisplay,
  findTableAtPos,
  focusTableCell,
  type ParsedTable,
} from "./tables";

/** Matches counted for the "n / total" label; beyond this it shows "n / 9999+". */
export const MATCH_COUNT_LIMIT = 9999;
/** Longest selection used as a query (Cmd+F / Cmd+E). */
export const MAX_SEED_LENGTH = 500;

export interface MatchRange {
  from: number;
  to: number;
}

export interface MatchList {
  ranges: MatchRange[];
  /** More matches exist than `limit`. */
  capped: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** All non-empty matches of `query` in `from..to` (document order). Never throws. */
export function collectMatches(
  state: EditorState,
  query: SearchQuery,
  limit = MATCH_COUNT_LIMIT,
  from = 0,
  to = state.doc.length,
): MatchList {
  const ranges: MatchRange[] = [];
  if (!query.valid) return { ranges, capped: false };
  try {
    const cursor = query.getCursor(state, from, to);
    for (;;) {
      const r = cursor.next();
      if (r.done) break;
      if (r.value.from === r.value.to) continue;
      if (ranges.length >= limit) return { ranges, capped: true };
      ranges.push({ from: r.value.from, to: r.value.to });
    }
  } catch {
    return { ranges: [], capped: false };
  }
  return { ranges, capped: false };
}

/** First non-empty match starting at or after `pos`, wrapping to the top. */
export function findMatchFrom(
  state: EditorState,
  query: SearchQuery,
  pos: number,
): MatchRange | null {
  if (!query.valid) return null;
  const first = (from: number, to: number): MatchRange | null => {
    try {
      const cursor = query.getCursor(state, from, to);
      for (;;) {
        const r = cursor.next();
        if (r.done) return null;
        if (r.value.from !== r.value.to)
          return { from: r.value.from, to: r.value.to };
      }
    } catch {
      return null;
    }
  };
  const p = Math.max(0, Math.min(pos, state.doc.length));
  return first(p, state.doc.length) ?? first(0, state.doc.length);
}

/** Index of the match equal to `sel` (binary search), or -1. */
export function currentMatchIndex(
  ranges: MatchRange[],
  sel: MatchRange,
): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (r.from < sel.from || (r.from === sel.from && r.to < sel.to))
      lo = mid + 1;
    else if (r.from > sel.from || r.to > sel.to) hi = mid - 1;
    else return mid;
  }
  return -1;
}

export function regexError(source: string): string | null {
  try {
    new RegExp(source, "u");
    return null;
  } catch (e) {
    try {
      new RegExp(source);
      return null;
    } catch {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

export interface MatchLabelInput {
  query: SearchQuery;
  total: number;
  capped: boolean;
  /** -1 when the selection is not on a match. */
  current: number;
}

export function matchLabel({
  query,
  total,
  capped,
  current,
}: MatchLabelInput): string {
  if (!query.search) return "";
  if (!query.valid) return query.regexp ? "正規表示式無效" : "";
  if (total === 0) return "無結果";
  const totalText = capped ? `${total}+` : String(total);
  return `${current >= 0 ? current + 1 : "?"} / ${totalText}`;
}

/** Selected text → query source (escaped so it matches itself). */
export function selectionToQueryText(text: string, regexp: boolean): string {
  if (regexp) {
    return text
      .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
      .replace(/\r?\n/g, "\\n")
      .replace(/\t/g, "\\t");
  }
  // Non-literal string queries read \n, \t, \r and \\ as escapes.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export interface TableHit {
  table: ParsedTable;
  /** 0 = header row, 1.. = body rows (as focusTableCell). */
  row: number;
  col: number;
}

function cellOf(
  table: ParsedTable,
  from: number,
  to: number,
): { row: number; col: number } | null {
  const rows = [table.headerRow, ...table.bodyRows];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (from > row.to || to < row.from) continue;
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      if (from >= cell.contentFrom && to <= cell.contentTo)
        return { row: r, col: c };
    }
  }
  return null;
}

/** The table cell whose content holds `from..to`, or null. */
export function tableHitAt(
  state: EditorState,
  from: number,
  to: number,
): TableHit | null {
  const table = findTableAtPos(state, from);
  if (!table || from < table.from || to > table.to) return null;
  const cell = cellOf(table, from, to);
  return cell ? { table, ...cell } : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const panels = new WeakMap<EditorView, KalamosSearchPanel>();

function activeCellIn(view: EditorView): HTMLElement | null {
  const active = view.dom.ownerDocument.activeElement;
  return active instanceof HTMLElement &&
    active.classList.contains("k-table-cell-content") &&
    view.contentDOM.contains(active)
    ? active
    : null;
}

/** The editor (or one of its table cells) has keyboard focus. */
function editorHasFocus(view: EditorView): boolean {
  return view.hasFocus || activeCellIn(view) !== null;
}

/** Text to seed the query with: the cell's DOM selection, else CM's selection. */
function selectionSeed(view: EditorView): string | null {
  let text = "";
  const cell = activeCellIn(view);
  if (cell) {
    text = view.dom.ownerDocument.getSelection()?.toString() ?? "";
  } else {
    const sel = view.state.selection.main;
    if (!sel.empty) text = view.state.sliceDoc(sel.from, sel.to);
  }
  if (!text || text.length > MAX_SEED_LENGTH) return null;
  return text;
}

function withSearch(
  query: SearchQuery,
  patch: Partial<ConstructorParameters<typeof SearchQuery>[0]>,
): SearchQuery {
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    wholeWord: query.wholeWord,
    replace: query.replace,
    ...patch,
  });
}

function seedQuery(view: EditorView, seed: string): void {
  const prev = getSearchQuery(view.state);
  const next = withSearch(prev, {
    search: selectionToQueryText(seed, prev.regexp),
  });
  if (!next.eq(prev)) view.dispatch({ effects: setSearchQuery.of(next) });
}

function isTypewriter(view: EditorView): boolean {
  return view.dom.classList.contains("k-typewriter-mode");
}

function scrollEffect(view: EditorView, range: MatchRange) {
  return EditorView.scrollIntoView(
    EditorSelection.range(range.from, range.to),
    {
      y: isTypewriter(view) ? "center" : "nearest",
      yMargin: 48,
    },
  );
}

function findTableCellDom(view: EditorView, hit: TableHit): HTMLElement | null {
  for (const wrapper of view.contentDOM.querySelectorAll<HTMLElement>(
    ".k-table-wrapper",
  )) {
    let pos: number;
    try {
      pos = view.posAtDOM(wrapper);
    } catch {
      continue;
    }
    if (pos !== hit.table.from) continue;
    return wrapper.querySelector<HTMLElement>(
      `[data-row="${hit.row}"][data-col="${hit.col}"]`,
    );
  }
  return null;
}

/** A hit inside a table widget: scroll its cell into view once layout settled. */
function revealTableCellLater(view: EditorView): void {
  const raf = view.dom.ownerDocument.defaultView?.requestAnimationFrame;
  if (!raf) return;
  raf(() => {
    if (!view.dom.isConnected) return;
    const sel = view.state.selection.main;
    const hit = tableHitAt(view.state, sel.from, sel.to);
    const td = hit ? findTableCellDom(view, hit) : null;
    if (td && typeof td.scrollIntoView === "function") {
      td.scrollIntoView({
        block: isTypewriter(view) ? "center" : "nearest",
        inline: "nearest",
      });
    }
  });
}

/**
 * After the selection moved to a hit: focus the table cell holding it (only
 * when the editor already had focus — typing in the find bar keeps focus
 * there) and make sure the cell is on screen.
 */
function afterNavigate(view: EditorView, focusEditor: boolean): void {
  const sel = view.state.selection.main;
  const hit = tableHitAt(view.state, sel.from, sel.to);
  if (!hit) return;
  if (focusEditor)
    focusTableCell(view, hit.table.from, hit.row, hit.col, {
      from: sel.from,
      to: sel.to,
    });
  revealTableCellLater(view);
}

/**
 * #73 B: select `from..to`, scroll it into view (centred in typewriter mode)
 * and focus the editor — or, for a hit inside a table cell, that cell.
 */
export function revealRange(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const range = {
    from: Math.max(0, Math.min(from, len)),
    to: Math.max(0, Math.min(to, len)),
  };
  view.dispatch({
    selection: EditorSelection.single(range.from, range.to),
    effects: scrollEffect(view, range),
    userEvent: "select.search",
  });
  const hit = tableHitAt(view.state, range.from, range.to);
  if (hit) {
    focusTableCell(view, hit.table.from, hit.row, hit.col, range);
    revealTableCellLater(view);
  } else {
    view.focus();
  }
}

/** 1-based line / column (UTF-16 units) → document range, clamped to the line. */
export function lineColumnToRange(
  state: EditorState,
  line: number,
  column: number,
  length: number,
): MatchRange {
  const l = state.doc.line(Math.max(1, Math.min(line, state.doc.lines)));
  const from = Math.min(l.from + Math.max(0, column - 1), l.to);
  return { from, to: Math.min(from + Math.max(0, length), l.to) };
}

/** Cmd+F (find) / Cmd+Opt+F (find + replace). */
export function openFind(
  view: EditorView,
  options: { replace?: boolean } = {},
): boolean {
  const seed = selectionSeed(view);
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  if (seed) seedQuery(view, seed);
  const panel = panels.get(view);
  if (panel) {
    panel.setReplaceVisible(Boolean(options.replace));
    panel.focus(
      options.replace && getSearchQuery(view.state).search ? "replace" : "find",
    );
  }
  return true;
}

/** Cmd+E: the selection becomes the query. */
export function useSelectionForFind(view: EditorView): boolean {
  const seed = selectionSeed(view);
  if (!seed) return false;
  seedQuery(view, seed);
  return true;
}

function navigate(view: EditorView, dir: 1 | -1): boolean {
  const focusEditor = editorHasFocus(view);
  if (!getSearchQuery(view.state).valid) return openFind(view);
  const moved = dir > 0 ? findNext(view) : findPrevious(view);
  if (moved) afterNavigate(view, focusEditor);
  return true;
}

/** Cmd+G / Enter. */
export const findNextMatch = (view: EditorView): boolean => navigate(view, 1);
/** Cmd+Shift+G / Shift+Enter. */
export const findPreviousMatch = (view: EditorView): boolean =>
  navigate(view, -1);

/** Replace the current hit (or select the next one) — @codemirror/search replaceNext. */
export function replaceCurrent(view: EditorView): boolean {
  if (!getSearchQuery(view.state).valid) return false;
  const done = replaceNext(view);
  if (done) afterNavigate(view, false);
  return done;
}

/** Replace every hit in one transaction (one undo step). */
export function replaceAllMatches(view: EditorView): boolean {
  if (!getSearchQuery(view.state).valid) return false;
  return replaceAll(view);
}

/** Esc: close the bar; focus goes back to the editor at the selection. */
export function closeFind(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false;
  const panel = panels.get(view);
  const doc = view.dom.ownerDocument;
  const hadFocus =
    editorHasFocus(view) || Boolean(panel?.dom.contains(doc.activeElement));
  closeSearchPanel(view);
  if (hadFocus) {
    const sel = view.state.selection.main;
    const hit = tableHitAt(view.state, sel.from, sel.to);
    if (hit)
      focusTableCell(view, hit.table.from, hit.row, hit.col, {
        from: sel.from,
        to: sel.to,
      });
    else if (!view.hasFocus) view.focus();
  }
  return true;
}

export const kalamosSearchKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", preventDefault: true, run: (view) => openFind(view) },
  {
    key: "Mod-Alt-f",
    preventDefault: true,
    run: (view) => openFind(view, { replace: true }),
  },
  {
    key: "Mod-g",
    preventDefault: true,
    run: findNextMatch,
    shift: findPreviousMatch,
  },
  { key: "Mod-e", preventDefault: true, run: useSelectionForFind },
  { key: "Escape", run: closeFind },
];

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("k-search-icon");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const ICONS = {
  chevron: ["M6 4l4 4-4 4"],
  up: ["M8 12.5V3.5", "M4 7.5l4-4 4 4"],
  down: ["M8 3.5v9", "M4 8.5l4 4 4-4"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
};

function button(
  className: string,
  testid: string,
  label: string,
  content: Node | string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.dataset.testid = testid;
  b.title = label;
  b.setAttribute("aria-label", label);
  if (typeof content === "string") b.textContent = content;
  else b.appendChild(content);
  // Keep keyboard focus where it is (the find field, or the editor).
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

function field(testid: string, placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "k-search-input";
  input.dataset.testid = testid;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  return input;
}

/** Window-level shortcuts that would edit the document while typing a query. */
function isDocumentEditingShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey) return e.code === "KeyT";
  if (!e.shiftKey)
    return e.code === "KeyB" || e.code === "KeyI" || e.code === "KeyK";
  return ["Backquote", "BracketLeft", "BracketRight", "KeyX", "KeyC"].includes(
    e.code,
  );
}

class KalamosSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly findField: HTMLElement;
  private readonly replaceRow: HTMLElement;
  private readonly toggleReplace: HTMLButtonElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly regexBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private query: SearchQuery;
  private matches: MatchList = { ranges: [], capped: false };
  private composing = false;
  private replaceVisible = false;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);

    const dom = document.createElement("div");
    dom.className = "k-search";
    dom.dataset.testid = "search-panel";
    dom.setAttribute("role", "search");
    this.dom = dom;

    this.toggleReplace = button(
      "k-search-btn k-search-toggle",
      "search-toggle-replace",
      "切換取代",
      icon(ICONS.chevron),
    );
    this.toggleReplace.setAttribute("aria-expanded", "false");

    this.findInput = field("search-input", "尋找");
    this.caseBtn = button("k-search-opt", "search-case", "區分大小寫", "Aa");
    this.wordBtn = button(
      "k-search-opt k-search-opt-word",
      "search-word",
      "全字比對",
      "ab",
    );
    this.regexBtn = button("k-search-opt", "search-regex", "正規表示式", ".*");
    for (const b of [this.caseBtn, this.wordBtn, this.regexBtn])
      b.setAttribute("aria-pressed", "false");
    const options = document.createElement("div");
    options.className = "k-search-options";
    options.append(this.caseBtn, this.wordBtn, this.regexBtn);
    this.findField = document.createElement("div");
    this.findField.className = "k-search-field";
    this.findField.append(this.findInput, options);

    this.countEl = document.createElement("span");
    this.countEl.className = "k-search-count";
    this.countEl.dataset.testid = "search-count";
    this.countEl.setAttribute("aria-live", "polite");

    const prev = button(
      "k-search-btn",
      "search-prev",
      "上一個（⇧⌘G）",
      icon(ICONS.up),
    );
    const next = button(
      "k-search-btn",
      "search-next",
      "下一個（⌘G）",
      icon(ICONS.down),
    );
    const close = button(
      "k-search-btn",
      "search-close",
      "關閉（Esc）",
      icon(ICONS.close),
    );

    const findRow = document.createElement("div");
    findRow.className = "k-search-row";
    findRow.append(
      this.toggleReplace,
      this.findField,
      this.countEl,
      prev,
      next,
      close,
    );

    this.replaceInput = field("replace-input", "取代");
    const replaceField = document.createElement("div");
    replaceField.className = "k-search-field";
    replaceField.append(this.replaceInput);
    const replaceOne = button(
      "k-search-text-btn",
      "replace-one",
      "取代（Enter）",
      "取代",
    );
    const replaceEvery = button(
      "k-search-text-btn",
      "replace-all",
      "全部取代（⌘Enter）",
      "全部取代",
    );
    const spacer = document.createElement("span");
    spacer.className = "k-search-spacer";
    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "k-search-row k-search-replace-row";
    this.replaceRow.hidden = true;
    this.replaceRow.append(spacer, replaceField, replaceOne, replaceEvery);

    dom.append(findRow, this.replaceRow);

    // Query input (IME: search only once composition ends).
    this.findInput.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.findInput.addEventListener("compositionend", () => {
      this.composing = false;
      this.commit(true);
    });
    this.findInput.addEventListener("input", (e) => {
      if (this.composing || (e as InputEvent).isComposing) return;
      this.commit(true);
    });
    this.replaceInput.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.replaceInput.addEventListener("compositionend", () => {
      this.composing = false;
      this.commit(false);
    });
    this.replaceInput.addEventListener("input", (e) => {
      if (this.composing || (e as InputEvent).isComposing) return;
      this.commit(false);
    });

    for (const b of [this.caseBtn, this.wordBtn, this.regexBtn]) {
      b.addEventListener("click", () => {
        b.setAttribute(
          "aria-pressed",
          b.getAttribute("aria-pressed") === "true" ? "false" : "true",
        );
        this.commit(true);
      });
    }
    this.toggleReplace.addEventListener("click", () => {
      this.setReplaceVisible(!this.replaceVisible);
      if (this.replaceVisible) this.focus("replace");
    });
    prev.addEventListener("click", () => findPreviousMatch(this.view));
    next.addEventListener("click", () => findNextMatch(this.view));
    close.addEventListener("click", () => closeFind(this.view));
    replaceOne.addEventListener("click", () => {
      this.commit(false);
      replaceCurrent(this.view);
    });
    replaceEvery.addEventListener("click", () => {
      this.commit(false);
      replaceAllMatches(this.view);
    });

    dom.addEventListener("keydown", (e) => this.onKeyDown(e));

    this.syncFromQuery();
    this.recount(view.state);
    panels.set(view, this);
  }

  mount(): void {
    this.focus("find");
  }

  update(update: ViewUpdate): void {
    const q = getSearchQuery(update.state);
    let recount = update.docChanged;
    if (q !== this.query) {
      this.query = q;
      this.syncFromQuery();
      recount = true;
    }
    if (recount) this.recount(update.state);
    else if (update.selectionSet) this.renderCount(update.state);
  }

  destroy(): void {
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  setReplaceVisible(visible: boolean): void {
    this.replaceVisible = visible;
    this.replaceRow.hidden = !visible;
    this.dom.dataset.replace = visible ? "true" : "false";
    this.toggleReplace.setAttribute(
      "aria-expanded",
      visible ? "true" : "false",
    );
  }

  focus(which: "find" | "replace"): void {
    const input =
      which === "replace" && this.replaceVisible
        ? this.replaceInput
        : this.findInput;
    input.focus();
    input.select();
  }

  private pressed(b: HTMLButtonElement): boolean {
    return b.getAttribute("aria-pressed") === "true";
  }

  /** Inputs / toggles → search query. `jump`: select the first hit from the selection. */
  private commit(jump: boolean): void {
    const { view } = this;
    const next = new SearchQuery({
      search: this.findInput.value,
      caseSensitive: this.pressed(this.caseBtn),
      wholeWord: this.pressed(this.wordBtn),
      regexp: this.pressed(this.regexBtn),
      replace: this.replaceInput.value,
    });
    const prev = getSearchQuery(view.state);
    if (!next.eq(prev)) view.dispatch({ effects: setSearchQuery.of(next) });
    if (!jump || !next.valid) return;
    const sel = view.state.selection.main;
    const hit = findMatchFrom(view.state, next, sel.from);
    if (!hit || (hit.from === sel.from && hit.to === sel.to)) return;
    view.dispatch({
      selection: EditorSelection.single(hit.from, hit.to),
      effects: scrollEffect(view, hit),
      userEvent: "select.search",
    });
    afterNavigate(view, false);
  }

  private syncFromQuery(): void {
    const q = this.query;
    if (!this.composing) {
      if (this.findInput.value !== q.search) this.findInput.value = q.search;
      if (this.replaceInput.value !== q.replace)
        this.replaceInput.value = q.replace;
    }
    this.caseBtn.setAttribute("aria-pressed", String(q.caseSensitive));
    this.wordBtn.setAttribute("aria-pressed", String(q.wholeWord));
    this.regexBtn.setAttribute("aria-pressed", String(q.regexp));
    const invalid = Boolean(q.search) && !q.valid && q.regexp;
    this.findField.dataset.invalid = invalid ? "true" : "false";
    this.findInput.setAttribute("aria-invalid", invalid ? "true" : "false");
    this.findField.title = invalid ? (regexError(q.search) ?? "") : "";
  }

  private recount(state: EditorState): void {
    this.matches = collectMatches(state, this.query);
    this.renderCount(state);
  }

  private renderCount(state: EditorState): void {
    const sel = state.selection.main;
    const current = currentMatchIndex(this.matches.ranges, sel);
    const text = matchLabel({
      query: this.query,
      total: this.matches.ranges.length,
      capped: this.matches.capped,
      current,
    });
    this.countEl.textContent = text;
    const state_ = !this.query.search
      ? "empty"
      : !this.query.valid
        ? "invalid"
        : this.matches.ranges.length === 0
          ? "none"
          : "some";
    this.countEl.dataset.state = state_;
    this.dom.dataset.state = state_;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229 || this.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    const { view } = this;
    let handled = true;
    if (e.key === "Escape") {
      closeFind(view);
    } else if (
      e.key === "Enter" &&
      e.target === this.findInput &&
      !mod &&
      !e.altKey
    ) {
      if (e.shiftKey) findPreviousMatch(view);
      else findNextMatch(view);
    } else if (
      e.key === "Enter" &&
      e.target === this.replaceInput &&
      !e.altKey
    ) {
      this.commit(false);
      if (mod) replaceAllMatches(view);
      else replaceCurrent(view);
    } else if (mod && !e.altKey && e.code === "KeyG") {
      if (e.shiftKey) findPreviousMatch(view);
      else findNextMatch(view);
    } else if (mod && e.altKey && !e.shiftKey && e.code === "KeyF") {
      this.setReplaceVisible(true);
      this.focus("replace");
    } else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyF") {
      this.focus("find");
    } else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyE") {
      useSelectionForFind(view);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    } else if (isDocumentEditingShortcut(e)) {
      // Cmd+B / Cmd+K… in the find field must not edit the document.
      e.stopPropagation();
    }
  }
}

// ---------------------------------------------------------------------------
// Hits inside table widgets
// ---------------------------------------------------------------------------

const MATCH_HIGHLIGHT = "k-search-match";
const CURRENT_HIGHLIGHT = "k-search-current";
export const CURRENT_CELL_CLASS = "k-search-cell-current";

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): {
  registry: HighlightRegistryLike;
  Ctor: new (...ranges: Range[]) => unknown;
} | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } })
    .CSS;
  const Ctor = (
    globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (!css?.highlights || typeof Ctor !== "function") return null;
  return { registry: css.highlights, Ctor };
}

/** A DOM Range over the first occurrence of `needle` in `root`'s text at or after `start`. */
function textRangeIn(
  root: HTMLElement,
  needle: string,
  start: number,
): { range: Range; end: number } | null {
  if (!needle) return null;
  const nodes: Text[] = [];
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    text += (n as Text).data;
  }
  const idx = text.indexOf(needle, start);
  if (idx < 0) return null;
  const end = idx + needle.length;
  const locate = (
    offset: number,
    preferEnd: boolean,
  ): [Text, number] | null => {
    let acc = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (offset < acc + len || (preferEnd && offset === acc + len))
        return [node, offset - acc];
      acc += len;
    }
    return null;
  };
  const s = locate(idx, false);
  const e = locate(end, true);
  if (!s || !e) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(s[0], s[1]);
  range.setEnd(e[0], e[1]);
  return { range, end };
}

/**
 * CodeMirror's match decorations cannot reach into the table widget, so hits
 * in table cells are painted with the CSS Custom Highlight API, and the cell
 * holding the current hit gets `k-search-cell-current` (also where that API is
 * missing).
 */
const tableSearchMarks = ViewPlugin.fromClass(
  class {
    marked = new Set<HTMLElement>();
    scheduled = false;
    destroyed = false;
    readonly onFocusChange = () => this.schedule();

    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("focusin", this.onFocusChange);
      view.contentDOM.addEventListener("focusout", this.onFocusChange);
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        getSearchQuery(update.state) !== getSearchQuery(update.startState) ||
        searchPanelOpen(update.state) !== searchPanelOpen(update.startState)
      ) {
        this.schedule();
      }
    }

    schedule(): void {
      if (this.scheduled) return;
      this.scheduled = true;
      // After the DOM update of the current transaction (and cell focus handlers).
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.destroyed) this.apply();
      });
    }

    clear(): void {
      for (const td of this.marked) td.classList.remove(CURRENT_CELL_CLASS);
      this.marked.clear();
    }

    apply(): void {
      const { view } = this;
      this.clear();
      const api = highlightApi();
      const { state } = view;
      const query = getSearchQuery(state);
      if (!searchPanelOpen(state) || !query.valid || !view.dom.isConnected) {
        api?.registry.delete(MATCH_HIGHLIGHT);
        api?.registry.delete(CURRENT_HIGHLIGHT);
        return;
      }
      const sel = state.selection.main;
      const all: Range[] = [];
      const current: Range[] = [];
      for (const wrapper of view.contentDOM.querySelectorAll<HTMLElement>(
        ".k-table-wrapper",
      )) {
        let pos: number;
        try {
          pos = view.posAtDOM(wrapper);
        } catch {
          continue;
        }
        const table = findTableAtPos(state, pos);
        if (!table || table.from !== pos) continue;
        const searchFrom = new Map<HTMLElement, number>();
        for (const m of collectMatches(state, query, 2000, table.from, table.to)
          .ranges) {
          const cell = cellOf(table, m.from, m.to);
          if (!cell) continue;
          const td = wrapper.querySelector<HTMLElement>(
            `[data-row="${cell.row}"][data-col="${cell.col}"]`,
          );
          const content = td?.querySelector<HTMLElement>(
            ".k-table-cell-content",
          );
          if (!td || !content) continue;
          const isCurrent = m.from === sel.from && m.to === sel.to;
          if (isCurrent) {
            td.classList.add(CURRENT_CELL_CLASS);
            this.marked.add(td);
          }
          if (!api) continue;
          const needle = cellRawToDisplay(state.sliceDoc(m.from, m.to));
          const found = textRangeIn(
            content,
            needle,
            searchFrom.get(content) ?? 0,
          );
          if (!found) continue;
          searchFrom.set(content, found.end);
          (isCurrent ? current : all).push(found.range);
        }
      }
      if (api) {
        api.registry.set(MATCH_HIGHLIGHT, new api.Ctor(...all));
        api.registry.set(CURRENT_HIGHLIGHT, new api.Ctor(...current));
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.clear();
      this.view.contentDOM.removeEventListener("focusin", this.onFocusChange);
      this.view.contentDOM.removeEventListener("focusout", this.onFocusChange);
      const api = highlightApi();
      api?.registry.delete(MATCH_HIGHLIGHT);
      api?.registry.delete(CURRENT_HIGHLIGHT);
    }
  },
);

/** Search state + Kalamos panel + table-cell hit marks (works in source mode too). */
export const kalamosSearchExtension: Extension = [
  search({
    top: true,
    createPanel: (view) => new KalamosSearchPanel(view),
    scrollToMatch: (range, view) => scrollEffect(view, range),
  }),
  tableSearchMarks,
];
