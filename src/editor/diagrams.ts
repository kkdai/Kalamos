import "./diagrams.css";

/**
 * Diagrams (BL-04, issue #11).
 *
 * Fenced code blocks whose info string is `mermaid`, `flow` (flowchart.js
 * syntax) or `sequence` (js-sequence-diagrams syntax) are rendered to SVG by
 * Mermaid. `flow` / `sequence` are translated to Mermaid source first (both
 * original libraries are unmaintained and depend on Raphael / Snap.svg), so
 * everything renders offline through one engine with one theme.
 *
 * - Cursor outside the block: a block widget replaces the fence.
 * - Cursor inside: source stays visible, a live preview (debounced 300 ms)
 *   is drawn below the closing fence.
 * - Mermaid + DOMPurify are dynamically imported the first time a diagram
 *   widget is drawn, so documents without diagrams never load them.
 * - Results are cached (LRU) by source + kind + theme.
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { t } from "../i18n";
import { isSelectionTouchingRange } from "./live-preview";
import { mapPosClamped } from "./positions";

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

export type DiagramKind = "mermaid" | "flow" | "sequence";

export function resolveDiagramKind(infoString: string): DiagramKind | null {
  const token = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (token === "mermaid" || token === "flow" || token === "sequence") {
    return token;
  }
  return null;
}

export interface DiagramBlock {
  kind: DiagramKind;
  /** Start of the opening fence line. */
  from: number;
  /** End of the closing fence line. */
  to: number;
  /** Diagram source (lines between the fences). */
  source: string;
  active: boolean;
}

/** Closed diagram fences overlapping `[from, to]`. */
export function collectDiagramBlocks(
  state: EditorState,
  from = 0,
  to: number = state.doc.length,
): DiagramBlock[] {
  const tree = ensureSyntaxTree(state, to, 100) ?? syntaxTree(state);
  const blocks: DiagramBlock[] = [];
  tree.iterate({
    from,
    to,
    enter: (nodeRef) => {
      if (nodeRef.name !== "FencedCode") return;
      const node = nodeRef.node;
      const info = node.getChild("CodeInfo");
      if (!info) return false;
      const kind = resolveDiagramKind(state.sliceDoc(info.from, info.to));
      if (!kind) return false;
      const marks = node.getChildren("CodeMark");
      const startLine = state.doc.lineAt(nodeRef.from);
      const endLine = state.doc.lineAt(nodeRef.to);
      const hasClosingFence =
        marks.length >= 2 &&
        endLine.number > startLine.number &&
        state.doc.lineAt(marks[marks.length - 1].from).number ===
          endLine.number;
      // Unclosed fences run to the end of the document while typing; leave
      // them as plain code until they are closed.
      if (!hasClosingFence) return false;
      const source =
        endLine.number - startLine.number >= 2
          ? state.sliceDoc(
              state.doc.line(startLine.number + 1).from,
              state.doc.line(endLine.number - 1).to,
            )
          : "";
      blocks.push({
        kind,
        from: startLine.from,
        to: endLine.to,
        source,
        active: isSelectionTouchingRange(
          state.selection,
          startLine.from,
          endLine.to,
        ),
      });
      return false;
    },
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export interface DiagramTheme {
  key: string;
  dark: boolean;
  colors: {
    bg: string;
    surface: string;
    text: string;
    textMuted: string;
    accent: string;
    link: string;
    divider: string;
  };
  fontFamily: string;
}

const PAPYROS_FALLBACK: DiagramTheme["colors"] = {
  bg: "#F5EFE0",
  surface: "#EDE4CF",
  text: "#2B2622",
  textMuted: "#6E6355",
  accent: "#5E7A4A",
  link: "#A4552F",
  divider: "#D9CDB3",
};

function parseColor(value: string): [number, number, number] | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function isDarkColor(value: string): boolean {
  const rgb = parseColor(value);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** Current Papyros / Melan / custom palette, from the `--k-*` variables. */
export function readDiagramTheme(): DiagramTheme {
  const colors = { ...PAPYROS_FALLBACK };
  let fontFamily = "";
  if (
    typeof document !== "undefined" &&
    typeof getComputedStyle === "function"
  ) {
    const root = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string =>
      root.getPropertyValue(name).trim() || fallback;
    colors.bg = read("--k-bg", colors.bg);
    colors.surface = read("--k-surface", colors.surface);
    colors.text = read("--k-text", colors.text);
    colors.textMuted = read("--k-text-muted", colors.textMuted);
    colors.accent = read("--k-accent", colors.accent);
    colors.link = read("--k-link", colors.link);
    colors.divider = read("--k-divider", colors.divider);
    fontFamily = root.getPropertyValue("--k-font-body").trim();
  }
  return diagramThemeFromColors(colors, fontFamily);
}

/** A diagram theme from explicit colors (used for the PDF export's print theme). */
export function diagramThemeFromColors(
  colors: DiagramTheme["colors"],
  fontFamily = "",
): DiagramTheme {
  const dark = isDarkColor(colors.bg);
  return {
    key: JSON.stringify([dark, colors, fontFamily]),
    dark,
    colors: { ...colors },
    fontFamily,
  };
}

// ---------------------------------------------------------------------------
// Engine (lazy module boundary)
// ---------------------------------------------------------------------------

export interface DiagramRenderResult {
  /** Sanitised SVG markup ("" on error). */
  svg: string;
  error: string | null;
  /** 1-based error line inside the diagram source, when known. */
  line: number | null;
}

type DiagramEngineModule = typeof import("./diagram-engine");
let diagramEngineModule: DiagramEngineModule | null = null;
let diagramEngineModulePromise: Promise<DiagramEngineModule> | null = null;

/** True once the diagram engine module and Mermaid have been dynamically imported. */
export function isDiagramEngineLoaded(): boolean {
  return diagramEngineModule?.isDiagramEngineLoaded() ?? false;
}

function loadDiagramEngineModule(): Promise<DiagramEngineModule> {
  if (diagramEngineModule) return Promise.resolve(diagramEngineModule);
  if (!diagramEngineModulePromise) {
    diagramEngineModulePromise = import("./diagram-engine")
      .then((mod) => {
        diagramEngineModule = mod;
        return mod;
      })
      .catch((err) => {
        diagramEngineModulePromise = null;
        throw err;
      });
  }
  return diagramEngineModulePromise;
}

function cacheKey(
  kind: DiagramKind,
  source: string,
  theme: DiagramTheme,
): string {
  return `${theme.key}\u0000${kind}\u0000${source}`;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export const PREVIEW_DEBOUNCE_MS = 300;

interface MountState {
  key: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const mountStates = new WeakMap<HTMLElement, MountState>();

export function diagramErrorTitle(result: DiagramRenderResult): string {
  return result.line !== null
    ? t("editor.diagram.syntaxErrorLine", { line: result.line })
    : t("editor.diagram.syntaxError");
}

function showResult(dom: HTMLElement, result: DiagramRenderResult): void {
  dom.replaceChildren();
  if (result.error) {
    dom.dataset.state = "error";
    const err = document.createElement("div");
    err.className = "k-diagram-error";
    err.dataset.testid = "diagram-error";
    err.setAttribute("role", "alert");
    if (result.line !== null) err.dataset.line = String(result.line);
    const title = document.createElement("div");
    title.className = "k-diagram-error-title";
    title.textContent = diagramErrorTitle(result);
    const detail = document.createElement("pre");
    detail.className = "k-diagram-error-detail";
    detail.textContent = result.error.slice(0, 600);
    err.append(title, detail);
    dom.appendChild(err);
    return;
  }
  dom.dataset.state = "rendered";
  const wrap = document.createElement("div");
  wrap.className = "k-diagram-svg";
  wrap.innerHTML = result.svg;
  dom.appendChild(wrap);
}

function showPending(dom: HTMLElement): void {
  dom.dataset.state = "pending";
  const p = document.createElement("div");
  p.className = "k-diagram-pending";
  p.textContent = t("editor.diagram.rendering");
  dom.replaceChildren(p);
}

function scheduleRender(
  dom: HTMLElement,
  widget: DiagramWidget,
  view: EditorView,
  delay: number,
): void {
  let st = mountStates.get(dom);
  if (!st) {
    st = { key: null, timer: null };
    mountStates.set(dom, st);
  }
  if (st.timer !== null) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  const key = cacheKey(widget.kind, widget.source, widget.theme);
  st.key = key;
  dom.dataset.source = widget.source;

  const cached = diagramEngineModule?.getCachedDiagram(
    widget.kind,
    widget.source,
    widget.theme,
  );
  if (cached) {
    showResult(dom, cached);
    return;
  }
  if (!dom.firstChild) showPending(dom);

  const state = st;
  const run = (): void => {
    state.timer = null;
    void loadDiagramEngineModule()
      .then((mod) =>
        mod.renderDiagram(widget.kind, widget.source, widget.theme),
      )
      .catch(
        (err): DiagramRenderResult => ({
          svg: "",
          error: t("editor.diagram.engineLoadFailed", {
            detail: err instanceof Error ? err.message : String(err),
          }),
          line: null,
        }),
      )
      .then((result) => {
        if (state.key !== key) return; // superseded by a newer source
        showResult(dom, result);
        if (dom.isConnected) view.requestMeasure();
      });
  };
  if (delay > 0) {
    state.timer = setTimeout(run, delay);
  } else {
    run();
  }
}

export class DiagramWidget extends WidgetType {
  constructor(
    readonly kind: DiagramKind,
    readonly source: string,
    readonly theme: DiagramTheme,
    readonly isPreview: boolean,
  ) {
    super();
  }

  eq(other: DiagramWidget): boolean {
    return (
      this.kind === other.kind &&
      this.source === other.source &&
      this.theme.key === other.theme.key &&
      this.isPreview === other.isPreview
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = this.isPreview
      ? "k-diagram k-diagram-preview"
      : "k-diagram";
    dom.dataset.testid = this.isPreview ? "diagram-preview" : "diagram";
    dom.dataset.kind = this.kind;
    dom.dataset.preview = String(this.isPreview);
    scheduleRender(dom, this, view, 0);

    if (!this.isPreview) {
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        let pos: number;
        try {
          pos = view.posAtDOM(dom);
        } catch {
          return;
        }
        // Into the first source line, so the source + preview appear.
        const line = view.state.doc.lineAt(pos);
        const target =
          line.number < view.state.doc.lines
            ? view.state.doc.line(line.number + 1).from
            : line.to;
        view.dispatch({ selection: { anchor: target } });
        view.focus();
      });
    }
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.dataset.preview !== String(this.isPreview)) return false;
    dom.dataset.kind = this.kind;
    // Keep showing the previous render while typing; re-render after a pause.
    scheduleRender(dom, this, view, this.isPreview ? PREVIEW_DEBOUNCE_MS : 0);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const st = mountStates.get(dom);
    if (st) {
      if (st.timer !== null) clearTimeout(st.timer);
      st.timer = null;
      st.key = null;
    }
  }

  get estimatedHeight(): number {
    return 160;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// State field
// ---------------------------------------------------------------------------

export const setDiagramThemeEffect = StateEffect.define<DiagramTheme>();
/** Re-decorate after IME composition (dispatched on compositionend). */
export const diagramRefreshEffect = StateEffect.define<null>();

interface PosRange {
  from: number;
  to: number;
}

export interface DiagramFieldValue {
  decorations: DecorationSet;
  theme: DiagramTheme;
  dirty: readonly PosRange[];
  dirtyAll: boolean;
  parsedTo: number;
}

function decorateBlock(
  block: DiagramBlock,
  theme: DiagramTheme,
  out: Array<Range<Decoration>>,
): void {
  if (block.active) {
    out.push(
      Decoration.widget({
        widget: new DiagramWidget(block.kind, block.source, theme, true),
        block: true,
        side: 1,
      }).range(block.to),
    );
  } else {
    out.push(
      Decoration.replace({
        widget: new DiagramWidget(block.kind, block.source, theme, false),
        block: true,
      }).range(block.from, block.to),
    );
  }
}

function fullValue(state: EditorState, theme: DiagramTheme): DiagramFieldValue {
  const out: Array<Range<Decoration>> = [];
  for (const b of collectDiagramBlocks(state)) decorateBlock(b, theme, out);
  return {
    decorations: Decoration.set(out, true),
    theme,
    dirty: [],
    dirtyAll: false,
    parsedTo: syntaxTree(state).length,
  };
}

export function buildDiagramDecorations(
  state: EditorState,
  theme: DiagramTheme = readDiagramTheme(),
): DecorationSet {
  return fullValue(state, theme).decorations;
}

const STRUCTURAL_MARKERS = /```|~~~/;

function lineSpanText(state: EditorState, from: number, to: number): string {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state.sliceDoc(start, end);
}

function isStructuralChange(tr: Transaction): boolean {
  let structural = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (structural) return;
    if (
      STRUCTURAL_MARKERS.test(lineSpanText(tr.startState, fromA, toA)) ||
      STRUCTURAL_MARKERS.test(lineSpanText(tr.state, fromB, toB))
    ) {
      structural = true;
    }
  });
  return structural;
}

function selectionRanges(selection: EditorSelection): PosRange[] {
  return selection.ranges.map((r) => ({ from: r.from, to: r.to }));
}

function rebuildRegions(
  state: EditorState,
  decorations: DecorationSet,
  theme: DiagramTheme,
  regions: PosRange[],
): DecorationSet {
  let result = decorations;
  const clamp = (n: number): number =>
    Math.max(0, Math.min(n, state.doc.length));
  for (const r of regions) {
    let from = state.doc.lineAt(clamp(r.from)).from;
    let to = state.doc.lineAt(clamp(r.to)).to;
    const blocks = collectDiagramBlocks(state, from, to);
    for (const b of blocks) {
      from = Math.min(from, b.from);
      to = Math.max(to, b.to);
    }
    const add: Array<Range<Decoration>> = [];
    for (const b of blocks) decorateBlock(b, theme, add);
    result = result.update({
      filterFrom: from,
      filterTo: to,
      filter: (f, t) => !(f <= to && t >= from),
      add,
      sort: true,
    });
  }
  return result;
}

export const diagramStateField = StateField.define<DiagramFieldValue>({
  create(state) {
    return fullValue(state, readDiagramTheme());
  },
  update(value, tr) {
    let theme = value.theme;
    let themeChanged = false;
    for (const e of tr.effects) {
      if (e.is(setDiagramThemeEffect) && e.value.key !== theme.key) {
        theme = e.value;
        themeChanged = true;
      }
    }
    const refresh = tr.effects.some((e) => e.is(diagramRefreshEffect));

    // IME composition: never re-decorate while composing; just map.
    if (tr.isUserEvent("input.type.compose")) {
      const dirty: PosRange[] = value.dirty.map((r) => ({
        from: mapPosClamped(tr.changes, r.from, -1),
        to: mapPosClamped(tr.changes, r.to, 1),
      }));
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        dirty.push({ from: fromB, to: toB });
      });
      return {
        decorations: value.decorations.map(tr.changes),
        theme,
        dirty,
        dirtyAll:
          value.dirtyAll ||
          themeChanged ||
          (tr.docChanged && isStructuralChange(tr)),
        // Mapped, not copied: a copied position can fall outside the next
        // (shorter) document and make mapPos throw (#56).
        parsedTo: mapPosClamped(tr.changes, value.parsedTo, 1),
      };
    }

    const pendingDirty = value.dirty.length > 0 || value.dirtyAll;
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      !tr.docChanged &&
      !tr.selection &&
      !tr.reconfigured &&
      !themeChanged &&
      !(refresh && pendingDirty) &&
      (!treeChanged || pendingDirty)
    ) {
      return value;
    }

    if (
      themeChanged ||
      tr.reconfigured ||
      value.dirtyAll ||
      (tr.docChanged && isStructuralChange(tr))
    ) {
      return fullValue(tr.state, theme);
    }

    const decorations = value.decorations.map(tr.changes);
    const regions: PosRange[] = value.dirty.map((r) => ({
      from: mapPosClamped(tr.changes, r.from, -1),
      to: mapPosClamped(tr.changes, r.to, 1),
    }));
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      regions.push({ from: fromB, to: toB });
    });
    if (tr.selection || tr.docChanged) {
      for (const r of selectionRanges(tr.startState.selection)) {
        regions.push({
          from: mapPosClamped(tr.changes, r.from, -1),
          to: mapPosClamped(tr.changes, r.to, 1),
        });
      }
      regions.push(...selectionRanges(tr.state.selection));
    }
    const parsedNow = syntaxTree(tr.state).length;
    let parsedTo = mapPosClamped(tr.changes, value.parsedTo, 1);
    if (parsedNow > parsedTo) {
      regions.push({ from: parsedTo, to: parsedNow });
      parsedTo = parsedNow;
    }
    return {
      decorations:
        regions.length > 0
          ? rebuildRegions(tr.state, decorations, theme, regions)
          : decorations,
      theme,
      dirty: [],
      dirtyAll: false,
      parsedTo,
    };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

/** Follows Papyros / Melan / custom theme switches and IME composition end. */
export const diagramThemePlugin = ViewPlugin.fromClass(
  class {
    private observer: MutationObserver | null = null;
    private media: MediaQueryList | null = null;
    private scheduled = false;
    private readonly onChange = (): void => this.schedule();

    constructor(readonly view: EditorView) {
      if (typeof document === "undefined") return;
      if (typeof MutationObserver === "function") {
        this.observer = new MutationObserver(this.onChange);
        this.observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: [
            "data-theme",
            "data-custom-theme",
            "data-system-dark-theme",
            "class",
            "style",
          ],
        });
        if (document.head) {
          this.observer.observe(document.head, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        }
      }
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function"
      ) {
        this.media = window.matchMedia("(prefers-color-scheme: dark)");
        this.media.addEventListener?.("change", this.onChange);
      }
      this.schedule();
    }

    schedule(): void {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.sync();
      });
    }

    sync(): void {
      if (this.view.composing || this.view.compositionStarted) return;
      const value = this.view.state.field(diagramStateField, false);
      if (!value) return;
      const theme = readDiagramTheme();
      if (theme.key !== value.theme.key) {
        try {
          this.view.dispatch({ effects: setDiagramThemeEffect.of(theme) });
        } catch {
          // view destroyed
        }
      }
    }

    destroy(): void {
      this.observer?.disconnect();
      this.media?.removeEventListener?.("change", this.onChange);
    }
  },
  {
    eventHandlers: {
      compositionend(_event, view) {
        queueMicrotask(() => {
          if (view.composing || view.compositionStarted) return;
          this.sync();
          const value = view.state.field(diagramStateField, false);
          if (value && (value.dirty.length > 0 || value.dirtyAll)) {
            try {
              view.dispatch({ effects: diagramRefreshEffect.of(null) });
            } catch {
              // view destroyed
            }
          }
        });
        return false;
      },
    },
  },
);

export const diagramsExtension: Extension = [
  diagramStateField,
  diagramThemePlugin,
];
