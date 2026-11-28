import { t } from "../i18n";
import type {
  DiagramKind,
  DiagramRenderResult,
  DiagramTheme,
} from "./diagrams";

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
  start: (text) => `(["${text}"])`,
  end: (text) => `(["${text}"])`,
  operation: (text) => `["${text}"]`,
  subroutine: (text) => `[["${text}"]]`,
  condition: (text) => `{"${text}"}`,
  inputoutput: (text) => `[/"${text}"/]`,
  parallel: (text) => `["${text}"]`,
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
        throw new DiagramSyntaxError(
          t("editor.diagram.unknownNode", { type }),
          lineNo,
        );
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
        throw new DiagramSyntaxError(
          t("editor.diagram.invalidConnection"),
          lineNo,
        );
      }
      edges.push({ line: lineNo, names });
      out.push(""); // filled after all nodes are known
      return;
    }
    throw new DiagramSyntaxError(t("editor.diagram.invalidFlow"), lineNo);
  });

  for (const edge of edges) {
    let line = "";
    edge.names.forEach((token, i) => {
      const m = /^([^\s()]+)(?:\(([^)]*)\))?$/.exec(token)!;
      const name = m[1];
      if (!defined.has(name)) {
        throw new DiagramSyntaxError(
          t("editor.diagram.undefinedNode", { name }),
          edge.line,
        );
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
    throw new DiagramSyntaxError(t("editor.diagram.invalidSequence"), lineNo);
  });
  return out.join("\n");
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
let renderQueue: Promise<unknown> | null = null;
let renderSeq = 0;

export function diagramCacheKey(
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
  return getCached(diagramCacheKey(kind, source, theme));
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
  return typeof msg === "string" && msg ? msg : t("editor.diagram.syntaxError");
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
    return { svg: "", error: t("editor.diagram.empty"), line: null };
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
      error: t("editor.diagram.engineLoadFailed", {
        detail: errorMessage(err),
      }),
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
  const key = diagramCacheKey(kind, source, theme);
  const cached = getCached(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const prev = renderQueue ?? Promise.resolve();
  const job = prev
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
