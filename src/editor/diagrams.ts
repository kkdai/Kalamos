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
import { type EditorHost, editorHostFacet } from "./editor-host";
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
// flowchart.js / js-sequence-diagrams -> Mermaid translation
// ---------------------------------------------------------------------------

export class DiagramSyntaxError extends Error {
  constructor(
    message: string,
    /** 1-based line number inside the diagram source. */
    readonly line: number | null,
  ) {
    super(message);
    this.name = "DiagramSyntaxError";
  }
}

/**
 * Translations keep the source line structure: output line N + 1 is the
 * translation of source line N (line 1 is the Mermaid header), so Mermaid
 * error line numbers map back with an offset of one.
 */
export const TRANSLATION_LINE_OFFSET = 1;

function mermaidText(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[\r\n]/g, " ");
}

const FLOW_SHAPES: Record<string, (text: string) => string> = {
  start: (t) => `(["${t}"])`,
  end: (t) => `(["${t}"])`,
  operation: (t) => `["${t}"]`,
  subroutine: (t) => `[["${t}"]]`,
  condition: (t) => `{"${t}"}`,
  inputoutput: (t) => `[/"${t}"/]`,
  parallel: (t) => `["${t}"]`,
};

/** flowchart.js syntax -> Mermaid `flowchart TD`. */
export function flowToMermaid(source: string): string {
  const lines = source.split(/\r?\n/);
  const ids = new Map<string, string>();
  const idFor = (name: string): string => {
    let id = ids.get(name);
    if (!id) {
      id = `f${ids.size}`;
      ids.set(name, id);
    }
    return id;
  };
  const defined = new Set<string>();
  const out: string[] = ["flowchart TD"];
  const edges: Array<{ line: number; names: string[] }> = [];

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const text = raw.trim();
    if (!text || text.startsWith("//")) {
      out.push("");
      return;
    }
    const def = /^([^\s=>]+)\s*=>\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(text);
    if (def) {
      const [, name, type, rest] = def;
      const shape = FLOW_SHAPES[type.toLowerCase()];
      if (!shape) {
        throw new DiagramSyntaxError(`未知的節點類型「${type}」`, lineNo);
      }
      const label = rest
        .replace(/:>\S*\s*$/, "") // link target (not followed, for safety)
        .replace(/\|[A-Za-z0-9_-]+\s*$/, "") // flowstate (past / current …)
        .trim();
      defined.add(name);
      out.push(`${idFor(name)}${shape(mermaidText(label || name))}`);
      return;
    }
    if (text.includes("->")) {
      const names = text.split("->").map((s) => s.trim());
      if (names.some((n) => !/^[^\s()]+(\([^)]*\))?$/.test(n))) {
        throw new DiagramSyntaxError("無法解析的連線語法", lineNo);
      }
      edges.push({ line: lineNo, names });
      out.push(""); // filled after all nodes are known
      return;
    }
    throw new DiagramSyntaxError("無法解析的 flowchart.js 語法", lineNo);
  });

  for (const edge of edges) {
    let line = "";
    edge.names.forEach((token, i) => {
      const m = /^([^\s()]+)(?:\(([^)]*)\))?$/.exec(token)!;
      const name = m[1];
      if (!defined.has(name)) {
        throw new DiagramSyntaxError(`未定義的節點「${name}」`, edge.line);
      }
      if (i > 0) {
        const prev = /^([^\s()]+)(?:\(([^)]*)\))?$/.exec(edge.names[i - 1])!;
        const opts = (prev[2] ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase());
        const label = opts.find((o) => o === "yes" || o === "no");
        line += label ? ` -->|${label}| ` : " --> ";
      }
      line += idFor(name);
    });
    out[edge.line] = line;
  }
  return out.join("\n");
}

const SEQUENCE_ARROWS: Record<string, string> = {
  "->": "->>",
  "-->": "-->>",
  "->>": "-)",
  "-->>": "--)",
};

function seqActor(name: string): string {
  return name.trim().replace(/^"(.*)"$/, "$1");
}

/** js-sequence-diagrams syntax -> Mermaid `sequenceDiagram`. */
export function sequenceToMermaid(source: string): string {
  const out: string[] = ["sequenceDiagram"];
  source.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const text = raw.trim();
    if (!text || text.startsWith("#")) {
      out.push("");
      return;
    }
    const title = /^title\s*:\s*(.*)$/i.exec(text);
    if (title) {
      out.push(`title ${title[1].trim()}`);
      return;
    }
    const participant = /^participant\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(text);
    if (participant) {
      const name = seqActor(participant[1]);
      out.push(
        participant[2]
          ? `participant ${seqActor(participant[2])} as ${name}`
          : `participant ${name}`,
      );
      return;
    }
    const note = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/i.exec(
      text,
    );
    if (note) {
      const actors = note[2].split(",").map(seqActor).join(",");
      out.push(`Note ${note[1].toLowerCase()} ${actors}: ${note[3] || " "}`);
      return;
    }
    const signal = /^([^:]+?)\s*(-->>|->>|-->|->)\s*([^:]+?)\s*:\s*(.*)$/.exec(
      text,
    );
    if (signal) {
      const [, a, arrow, b, msg] = signal;
      out.push(
        `${seqActor(a)}${SEQUENCE_ARROWS[arrow]}${seqActor(b)}: ${msg || " "}`,
      );
      return;
    }
    throw new DiagramSyntaxError("無法解析的序列圖語法", lineNo);
  });
  return out.join("\n");
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

/** Mermaid configuration. Exported for tests. */
export function mermaidConfig(theme: DiagramTheme): Record<string, unknown> {
  const c = theme.colors;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    // No HTML labels: everything is plain SVG text, nothing executable.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    // Keys that `%%{init}%%` directives / front matter may not override.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "htmlLabels",
      "dompurifyConfig",
      "themeCSS",
    ],
    theme: "base",
    darkMode: theme.dark,
    ...(theme.fontFamily ? { fontFamily: theme.fontFamily } : {}),
    themeVariables: {
      darkMode: theme.dark,
      background: c.bg,
      fontFamily: theme.fontFamily || undefined,
      primaryColor: c.surface,
      primaryTextColor: c.text,
      primaryBorderColor: c.accent,
      secondaryColor: c.bg,
      secondaryTextColor: c.text,
      secondaryBorderColor: c.divider,
      tertiaryColor: c.bg,
      tertiaryTextColor: c.text,
      tertiaryBorderColor: c.divider,
      lineColor: c.textMuted,
      textColor: c.text,
      mainBkg: c.surface,
      nodeBorder: c.accent,
      clusterBkg: c.bg,
      clusterBorder: c.divider,
      titleColor: c.text,
      edgeLabelBackground: c.bg,
      noteBkgColor: c.surface,
      noteTextColor: c.text,
      noteBorderColor: c.divider,
      actorBkg: c.surface,
      actorBorder: c.accent,
      actorTextColor: c.text,
      actorLineColor: c.textMuted,
      signalColor: c.text,
      signalTextColor: c.text,
      labelBoxBkgColor: c.surface,
      labelBoxBorderColor: c.divider,
      labelTextColor: c.text,
      loopTextColor: c.text,
      activationBkgColor: c.bg,
      activationBorderColor: c.accent,
      sectionBkgColor: c.surface,
      altSectionBkgColor: c.bg,
      taskBkgColor: c.accent,
      taskBorderColor: c.accent,
      taskTextColor: c.bg,
      taskTextOutsideColor: c.text,
      activeTaskBkgColor: c.link,
      activeTaskBorderColor: c.link,
      doneTaskBkgColor: c.divider,
      doneTaskBorderColor: c.textMuted,
      critBkgColor: c.link,
      critBorderColor: c.link,
      todayLineColor: c.link,
      gridColor: c.divider,
      errorBkgColor: c.bg,
      errorTextColor: c.link,
    },
  };
}

// ---------------------------------------------------------------------------
// Engine (lazy) + LRU cache
// ---------------------------------------------------------------------------

export interface DiagramRenderResult {
  /** Sanitised SVG markup ("" on error). */
  svg: string;
  error: string | null;
  /** 1-based error line inside the diagram source, when known. */
  line: number | null;
}

interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void;
  parse: (
    text: string,
    options?: { suppressErrors?: boolean },
  ) => Promise<unknown>;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

interface PurifierLike {
  sanitize: (dirty: string, config?: Record<string, unknown>) => unknown;
}

interface DiagramEngine {
  mermaid: MermaidLike;
  purify: PurifierLike;
}

export const MAX_DIAGRAM_CACHE_ENTRIES = 100;
const diagramCache = new Map<string, DiagramRenderResult>();
const inflight = new Map<string, Promise<DiagramRenderResult>>();
let enginePromise: Promise<DiagramEngine> | null = null;
let engineLoaded = false;
let initializedThemeKey: string | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function cacheKey(
  kind: DiagramKind,
  source: string,
  theme: DiagramTheme,
): string {
  return `${theme.key}\u0000${kind}\u0000${source}`;
}

function getCached(key: string): DiagramRenderResult | undefined {
  const hit = diagramCache.get(key);
  if (hit) {
    diagramCache.delete(key);
    diagramCache.set(key, hit);
  }
  return hit;
}

function setCached(key: string, value: DiagramRenderResult): void {
  if (diagramCache.has(key)) {
    diagramCache.delete(key);
  } else if (diagramCache.size >= MAX_DIAGRAM_CACHE_ENTRIES) {
    const oldest = diagramCache.keys().next().value;
    if (oldest !== undefined) diagramCache.delete(oldest);
  }
  diagramCache.set(key, value);
}

export function getCachedDiagram(
  kind: DiagramKind,
  source: string,
  theme: DiagramTheme,
): DiagramRenderResult | undefined {
  return getCached(cacheKey(kind, source, theme));
}

export function getDiagramCacheSize(): number {
  return diagramCache.size;
}

export function clearDiagramCache(): void {
  diagramCache.clear();
}

/** True once Mermaid has been dynamically imported. */
export function isDiagramEngineLoaded(): boolean {
  return engineLoaded;
}

function loadEngine(): Promise<DiagramEngine> {
  if (!enginePromise) {
    enginePromise = Promise.all([import("mermaid"), import("dompurify")]).then(
      ([m, p]) => {
        engineLoaded = true;
        return {
          mermaid: m.default as unknown as MermaidLike,
          purify: p.default as unknown as PurifierLike,
        };
      },
    );
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" && msg ? msg : "圖表語法錯誤";
}

/** 1-based error line from a Mermaid (jison / langium) error, if any. */
export function extractErrorLine(err: unknown): number | null {
  if (err instanceof DiagramSyntaxError) return err.line;
  const hash = (
    err as { hash?: { loc?: { first_line?: unknown }; line?: unknown } } | null
  )?.hash;
  if (hash) {
    if (typeof hash.loc?.first_line === "number") return hash.loc.first_line;
    if (typeof hash.line === "number") return hash.line + 1;
  }
  const m = /\bline[:\s]+(\d+)/i.exec(errorMessage(err));
  return m ? Number(m[1]) : null;
}

function removeStrayNodes(id: string): void {
  if (typeof document === "undefined") return;
  for (const strayId of [id, `d${id}`, `i${id}`]) {
    document.getElementById(strayId)?.remove();
  }
}

async function doRender(
  kind: DiagramKind,
  source: string,
  theme: DiagramTheme,
): Promise<DiagramRenderResult> {
  if (!source.trim()) {
    return { svg: "", error: "空白圖表（Empty diagram）", line: null };
  }
  let code = source;
  let lineOffset = 0;
  try {
    if (kind === "flow") {
      code = flowToMermaid(source);
      lineOffset = TRANSLATION_LINE_OFFSET;
    } else if (kind === "sequence") {
      code = sequenceToMermaid(source);
      lineOffset = TRANSLATION_LINE_OFFSET;
    }
  } catch (err) {
    return { svg: "", error: errorMessage(err), line: extractErrorLine(err) };
  }

  let engine: DiagramEngine;
  try {
    engine = await loadEngine();
  } catch (err) {
    return {
      svg: "",
      error: `無法載入圖表引擎：${errorMessage(err)}`,
      line: null,
    };
  }
  const { mermaid, purify } = engine;
  if (initializedThemeKey !== theme.key) {
    mermaid.initialize(mermaidConfig(theme));
    initializedThemeKey = theme.key;
  }

  const id = `k-mermaid-${++renderSeq}`;
  try {
    // Parse first so a syntax error never reaches the renderer (which could
    // otherwise leave an error SVG in the page).
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    const clean = String(
      purify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ["style"],
        FORBID_TAGS: ["script", "foreignObject"],
      }),
    );
    return { svg: clean, error: null, line: null };
  } catch (err) {
    const raw = extractErrorLine(err);
    const line = raw === null ? null : Math.max(1, raw - lineOffset);
    return { svg: "", error: errorMessage(err), line };
  } finally {
    removeStrayNodes(id);
  }
}

/** Renders (or returns the cached result of) one diagram. Renders are serialised. */
export function renderDiagram(
  kind: DiagramKind,
  source: string,
  theme: DiagramTheme,
): Promise<DiagramRenderResult> {
  const key = cacheKey(kind, source, theme);
  const cached = getCached(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = renderQueue
    .catch(() => undefined)
    .then(() => doRender(kind, source, theme))
    .then((result) => {
      setCached(key, result);
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });
  renderQueue = job;
  inflight.set(key, job);
  return job;
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

function diagramOpener(view: EditorView, kind: DiagramKind) {
  return kind === "mermaid"
    ? view.state.facet(editorHostFacet)[0]?.openDiagram
    : undefined;
}

function showResult(
  dom: HTMLElement,
  result: DiagramRenderResult,
  openDiagram?: EditorHost["openDiagram"],
): void {
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
    title.textContent =
      result.line !== null
        ? `圖表語法錯誤（第 ${result.line} 行）`
        : "圖表語法錯誤";
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
  const svg = wrap.querySelector("svg");
  const width = svg?.viewBox?.baseVal.width;
  if (svg && width && Number.isFinite(width) && width > 0) {
    // A percentage width in a flex item can resolve to SVG's 300px fallback.
    svg.style.width = `${width}px`;
    svg.style.maxWidth = "none";
    if (openDiagram) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "k-diagram-open";
      button.setAttribute("aria-label", "放大圖表");
      button.setAttribute("aria-haspopup", "dialog");
      button.title = "點一下放大圖表";
      const graphic = document.createElement("span");
      graphic.inert = true;
      graphic.append(svg);
      button.append(graphic);
      button.addEventListener("click", () => {
        button.focus({ preventScroll: true });
        openDiagram(svg);
      });
      wrap.append(button);
    }
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "圖表預覽");
  }
  dom.appendChild(wrap);
}

function showPending(dom: HTMLElement): void {
  dom.dataset.state = "pending";
  const p = document.createElement("div");
  p.className = "k-diagram-pending";
  p.textContent = "圖表渲染中…";
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
  const openDiagram = diagramOpener(view, widget.kind);

  const cached = getCached(key);
  if (cached) {
    showResult(dom, cached, openDiagram);
    return;
  }
  if (!dom.firstChild) showPending(dom);

  const state = st;
  const run = (): void => {
    state.timer = null;
    void renderDiagram(widget.kind, widget.source, widget.theme).then(
      (result) => {
        if (state.key !== key) return; // superseded by a newer source
        showResult(dom, result, openDiagram);
        if (dom.isConnected) view.requestMeasure();
      },
    );
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

    if (!this.isPreview && !diagramOpener(view, this.kind)) {
      dom.addEventListener("mousedown", (e) => {
        // Let the native horizontal scrollbar work without entering source mode.
        const scroller = e.target;
        if (
          scroller instanceof HTMLElement &&
          scroller.classList.contains("k-diagram-svg") &&
          scroller.scrollWidth > scroller.clientWidth
        ) {
          return;
        }
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
      !treeChanged &&
      !(refresh && pendingDirty)
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
          if (view.composing) return;
          const value = view.state.field(diagramStateField, false);
          if (value && (value.dirty.length > 0 || value.dirtyAll)) {
            view.dispatch({ effects: diagramRefreshEffect.of(null) });
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
