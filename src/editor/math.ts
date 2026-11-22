import "./math.css";

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  type Extension,
  Facet,
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
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type {
  BlockContext,
  InlineContext,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";
import { isSelectionTouchingRange } from "./live-preview";
import { mapPosClamped } from "./positions";

export const mathAutoNumberFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});

export const mathEngineLoadedEffect = StateEffect.define<boolean>();

/**
 * @lezer/markdown extension for InlineMath ($...$) and BlockMath ($$...$$).
 * Inline $...$ boundaries:
 * - Opening `$` cannot be followed by whitespace or `$`
 * - Closing `$` cannot be preceded by whitespace or `\`
 * - Closing `$` cannot be followed by a digit (0-9) or `$`
 * - Cannot span across newlines
 */
export const mathMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.special(tags.emphasis) },
    { name: "InlineMathMark", style: tags.processingInstruction },
    { name: "BlockMath", block: true },
    { name: "BlockMathMark", style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx: BlockContext, line: Line): boolean {
        const text = line.text.slice(line.pos);
        const openMatch = /^ {0,3}\$\$/.exec(text);
        if (!openMatch) return false;

        const blockFrom = cx.lineStart + line.pos;
        const openMarkFrom = blockFrom + openMatch[0].length - 2;
        const openMarkTo = openMarkFrom + 2;

        // Check for single-line $$...$$ block
        const restOfFirstLine = text.slice(openMatch[0].length);
        const sameLineClose = /^(.*)\$\$\s*$/.exec(restOfFirstLine);
        if (sameLineClose) {
          const closeMarkFrom = openMarkTo + sameLineClose[1].length;
          const closeMarkTo = closeMarkFrom + 2;
          const lineEnd = cx.lineStart + line.text.length;
          cx.addElement(
            cx.elt("BlockMath", blockFrom, lineEnd, [
              cx.elt("BlockMathMark", openMarkFrom, openMarkTo),
              cx.elt("BlockMathMark", closeMarkFrom, closeMarkTo),
            ]),
          );
          cx.nextLine();
          return true;
        }

        // Multi-line $$...$$ block
        while (cx.nextLine()) {
          const closeMatch = /^(.*)\$\$\s*$/.exec(line.text);
          if (closeMatch) {
            const closeMarkFrom = cx.lineStart + closeMatch[1].length;
            const closeMarkTo = closeMarkFrom + 2;
            const blockTo = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(
              cx.elt("BlockMath", blockFrom, blockTo, [
                cx.elt("BlockMathMark", openMarkFrom, openMarkTo),
                cx.elt("BlockMathMark", closeMarkFrom, closeMarkTo),
              ]),
            );
            return true;
          }
        }

        return false;
      },
    },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== 36 /* $ */) return -1;
        // Do not trigger if escaped (\$), preceded by $, or followed by $ ($$)
        if (pos > cx.offset && cx.char(pos - 1) === 92 /* \ */) return -1;
        if (pos > cx.offset && cx.char(pos - 1) === 36 /* $ */) return -1;
        if (pos + 1 >= cx.end || cx.char(pos + 1) === 36 /* $ */) return -1;

        // Opening `$` cannot be followed by whitespace
        const firstAfter = cx.slice(pos + 1, pos + 2);
        if (!firstAfter || /\s/.test(firstAfter)) return -1;

        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92 /* \ */) {
            i++;
            continue;
          }
          if (ch === 10 /* \n */ || ch === 13 /* \r */) {
            return -1;
          }
          if (ch === 36 /* $ */) {
            // Closing `$` cannot be preceded by whitespace
            const prevChar = cx.slice(i - 1, i);
            if (!prevChar || /\s/.test(prevChar)) {
              return -1;
            }
            // Closing `$` cannot be followed by a digit (0-9) or another `$`
            const nextChar = i + 1 < cx.end ? cx.slice(i + 1, i + 2) : "";
            if (/[0-9]/.test(nextChar) || nextChar === "$") {
              return -1;
            }
            return cx.addElement(
              cx.elt("InlineMath", pos, i + 1, [
                cx.elt("InlineMathMark", pos, pos + 1),
                cx.elt("InlineMathMark", i, i + 1),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

export interface MathRenderResult {
  svgHtml: string;
  error: string | null;
  equationNumbers: number[];
}

interface MathJaxEngine {
  render: (
    tex: string,
    display: boolean,
    autoNumber: boolean,
    startEquationNumber: number,
  ) => MathRenderResult;
}

export const MAX_MATH_CACHE_ENTRIES = 500;

/**
 * Allowed MathJax TeX packages.
 * SECURITY NOTE: Never add the "html" package (which provides \href, \class,
 * \style, \cssId) because MathJax SVG output is mounted via innerHTML; allowing
 * the "html" package would permit javascript: URLs and arbitrary attribute/style
 * injection (XSS).
 */
export const ALLOWED_TEX_PACKAGES = [
  "base",
  "ams",
  "mhchem",
  "bbox",
  "newcommand",
] as const;

const mathRenderCache = new Map<string, MathRenderResult>();
let mathEngineInstance: MathJaxEngine | null = null;
let mathEnginePromise: Promise<MathJaxEngine> | null = null;
const pendingViews = new Set<EditorView>();

function getCachedMathResult(key: string): MathRenderResult | undefined {
  const existing = mathRenderCache.get(key);
  if (existing !== undefined) {
    // Refresh key position for LRU ordering
    mathRenderCache.delete(key);
    mathRenderCache.set(key, existing);
  }
  return existing;
}

function setCachedMathResult(key: string, value: MathRenderResult): void {
  if (mathRenderCache.has(key)) {
    mathRenderCache.delete(key);
  } else if (mathRenderCache.size >= MAX_MATH_CACHE_ENTRIES) {
    const oldestKey = mathRenderCache.keys().next().value;
    if (oldestKey !== undefined) {
      mathRenderCache.delete(oldestKey);
    }
  }
  mathRenderCache.set(key, value);
}

export function getMathRenderCacheSize(): number {
  return mathRenderCache.size;
}

export function hasMathRenderCacheKey(key: string): boolean {
  return mathRenderCache.has(key);
}

export function clearMathRenderCache(): void {
  mathRenderCache.clear();
}

const NUMBERED_ENV_RE =
  /^\\begin\{(equation|align|gather|multline|eqnarray|flalign)\}/;
const ANY_BEGIN_ENV_RE = /^\\begin\{([a-zA-Z*]+)\}/;

function prepareDisplayTexForAutoNumber(
  trimmedTex: string,
  autoNumber: boolean,
): string {
  if (!autoNumber) return trimmedTex;
  if (NUMBERED_ENV_RE.test(trimmedTex)) {
    return trimmedTex;
  }
  if (
    ANY_BEGIN_ENV_RE.test(trimmedTex) ||
    /\\(?:notag|nonumber|tag)\b/.test(trimmedTex)
  ) {
    return trimmedTex;
  }
  return `\\begin{equation}\n${trimmedTex}\n\\end{equation}`;
}

export async function ensureMathJaxLoaded(
  view?: EditorView,
): Promise<MathJaxEngine> {
  if (view) {
    pendingViews.add(view);
  }
  if (mathEngineInstance) {
    return mathEngineInstance;
  }
  if (!mathEnginePromise) {
    mathEnginePromise = (async () => {
      const [
        { mathjax },
        { TeX },
        { SVG },
        { liteAdaptor },
        { RegisterHTMLHandler },
      ] = await Promise.all([
        import("mathjax-full/js/mathjax.js"),
        import("mathjax-full/js/input/tex.js"),
        import("mathjax-full/js/output/svg.js"),
        import("mathjax-full/js/adaptors/liteAdaptor.js"),
        import("mathjax-full/js/handlers/html.js"),
        import("mathjax-full/js/input/tex/base/BaseConfiguration.js"),
        import("mathjax-full/js/input/tex/ams/AmsConfiguration.js"),
        import("mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js"),
        import("mathjax-full/js/input/tex/bbox/BboxConfiguration.js"),
        import(
          "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js"
        ),
      ]);

      const adaptor = liteAdaptor();
      RegisterHTMLHandler(adaptor);

      let capturedError: string | null = null;
      const packages = [...ALLOWED_TEX_PACKAGES];

      const texNone = new TeX({
        packages,
        tags: "none",
        formatError: (
          jax: { formatError: (e: Error) => unknown },
          err: Error,
        ) => {
          capturedError = err.message || "TeX syntax error";
          return jax.formatError(err);
        },
      });

      const texAms = new TeX({
        packages,
        tags: "ams",
        formatError: (
          jax: { formatError: (e: Error) => unknown },
          err: Error,
        ) => {
          capturedError = err.message || "TeX syntax error";
          return jax.formatError(err);
        },
      });

      const svg = new SVG({ fontCache: "none" });
      const docNone = mathjax.document("", {
        InputJax: texNone,
        OutputJax: svg,
      });
      const docAms = mathjax.document("", { InputJax: texAms, OutputJax: svg });

      function runConvert(
        rawTex: string,
        display: boolean,
        useAms: boolean,
        startEqNum: number,
      ): { html: string; err: string | null; eqNums: number[] } {
        capturedError = null;
        const targetDoc = useAms ? docAms : docNone;
        if (useAms) {
          texAms.reset(Math.max(0, startEqNum - 1));
        } else {
          texNone.reset();
        }
        const node = targetDoc.convert(rawTex, { display });
        const html: string = adaptor.outerHTML(node);

        let err: string | null = capturedError;
        if (!err) {
          const merrorMatch = /data-mjx-error="([^"]+)"/.exec(html);
          if (merrorMatch) {
            err = merrorMatch[1];
          }
        }

        const eqNums: number[] = [];
        for (const m of html.matchAll(/id="mjx-eqn:(\d+)"/g)) {
          const n = Number(m[1]);
          if (!Number.isNaN(n) && !eqNums.includes(n)) {
            eqNums.push(n);
          }
        }

        return { html, err, eqNums };
      }

      const engine: MathJaxEngine = {
        render(
          tex: string,
          display: boolean,
          autoNumber: boolean,
          startEquationNumber: number,
        ): MathRenderResult {
          const trimmed = tex.trim();
          if (!trimmed) {
            return {
              svgHtml: "",
              error: "空白公式（Empty formula）",
              equationNumbers: [],
            };
          }

          const useAms = display && autoNumber;
          const cacheKey = useAms
            ? `block:ams:${startEquationNumber}:${trimmed}`
            : `${display ? "block" : "inline"}:none:${trimmed}`;

          const cached = getCachedMathResult(cacheKey);
          if (cached) {
            return cached;
          }

          const effectiveTex = useAms
            ? prepareDisplayTexForAutoNumber(trimmed, true)
            : trimmed;

          let conv = runConvert(
            effectiveTex,
            display,
            useAms,
            startEquationNumber,
          );
          if (conv.err && effectiveTex !== trimmed) {
            conv = runConvert(trimmed, display, useAms, startEquationNumber);
          }

          const result: MathRenderResult = conv.err
            ? { svgHtml: "", error: conv.err, equationNumbers: [] }
            : {
                svgHtml: conv.html,
                error: null,
                equationNumbers: conv.eqNums,
              };

          setCachedMathResult(cacheKey, result);
          return result;
        },
      };

      mathEngineInstance = engine;
      return engine;
    })();
  }

  const engine = await mathEnginePromise;
  for (const v of Array.from(pendingViews)) {
    pendingViews.delete(v);
    try {
      v.dispatch({ effects: mathEngineLoadedEffect.of(true) });
    } catch {
      // Ignore destroyed views
    }
  }
  return engine;
}

export function renderTeXSync(
  tex: string,
  display: boolean,
  autoNumber = false,
  startEquationNumber = 1,
): MathRenderResult | null {
  if (!mathEngineInstance) {
    return null;
  }
  return mathEngineInstance.render(
    tex,
    display,
    autoNumber,
    startEquationNumber,
  );
}

export function isMathEngineLoaded(): boolean {
  return mathEngineInstance !== null;
}

/**
 * Equation-number count per display formula (auto-numbering only). Lets the
 * decoration pass assign numbers without re-typesetting every formula; the
 * value is filled in the first time a formula is rendered.
 */
const equationCountCache = new Map<string, number>();
const MAX_EQUATION_COUNT_ENTRIES = 20_000;

function equationCountFor(tex: string, startEquationNumber: number): number {
  const key = tex.trim();
  const known = equationCountCache.get(key);
  if (known !== undefined) return known;
  const result = renderTeXSync(tex, true, true, startEquationNumber);
  if (!result) return 0;
  const count = result.equationNumbers.length;
  if (equationCountCache.size >= MAX_EQUATION_COUNT_ENTRIES) {
    equationCountCache.clear();
  }
  equationCountCache.set(key, count);
  return count;
}

function widgetPos(view: EditorView, dom: HTMLElement): number | null {
  try {
    return view.posAtDOM(dom);
  } catch {
    return null;
  }
}

/**
 * Inline `$...$` widget. Typesetting happens lazily in `toDOM`, so only
 * formulas CodeMirror actually draws (the viewport) are ever rendered.
 */
class InlineMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly engineReady: boolean,
  ) {
    super();
  }

  eq(other: InlineMathWidget): boolean {
    return this.tex === other.tex && this.engineReady === other.engineReady;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "k-math-inline";
    span.dataset.testid = "math-inline";
    span.dataset.tex = this.tex;

    const result = renderTeXSync(this.tex, false, false, 1);
    if (!result) {
      span.textContent = this.tex;
    } else if (result.error) {
      const errEl = document.createElement("span");
      errEl.className = "k-math-error";
      errEl.dataset.testid = "math-error";
      errEl.setAttribute("role", "alert");
      errEl.textContent = result.error;
      span.appendChild(errEl);
    } else {
      span.innerHTML = result.svgHtml;
    }

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = widgetPos(view, span);
      if (pos === null) return;
      const targetPos = Math.min(pos + 1, view.state.doc.length);
      view.dispatch({
        selection: { anchor: targetPos, head: targetPos },
      });
      view.focus();
    });

    return span;
  }
}

class BlockMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly isPreview: boolean,
    readonly engineReady: boolean,
    readonly autoNumber: boolean,
    readonly startEquationNumber: number,
  ) {
    super();
  }

  eq(other: BlockMathWidget): boolean {
    return (
      this.tex === other.tex &&
      this.isPreview === other.isPreview &&
      this.engineReady === other.engineReady &&
      this.autoNumber === other.autoNumber &&
      (!this.autoNumber ||
        this.startEquationNumber === other.startEquationNumber)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = this.isPreview
      ? "k-math-block k-math-block-preview"
      : "k-math-block";
    container.dataset.testid = this.isPreview
      ? "math-block-preview"
      : "math-block";
    container.dataset.tex = this.tex;

    const result = renderTeXSync(
      this.tex,
      true,
      this.autoNumber,
      this.startEquationNumber,
    );

    if (result && result.equationNumbers.length > 0) {
      container.dataset.equationNumber = result.equationNumbers.join(",");
    }

    if (!result) {
      container.textContent = this.tex;
    } else if (result.error) {
      const errEl = document.createElement("span");
      errEl.className = "k-math-error";
      errEl.dataset.testid = "math-error";
      errEl.setAttribute("role", "alert");
      errEl.textContent = result.error;
      container.appendChild(errEl);
    } else {
      const contentWrap = document.createElement("div");
      contentWrap.className = "k-math-svg-wrap";
      contentWrap.innerHTML = result.svgHtml;
      container.appendChild(contentWrap);

      if (result.equationNumbers.length > 0) {
        const eqBadge = document.createElement("span");
        eqBadge.className = "k-math-eq-number";
        eqBadge.dataset.testid = "math-eq-number";
        eqBadge.textContent = result.equationNumbers
          .map((n) => `(${n})`)
          .join(" ");
        container.appendChild(eqBadge);
      }
    }

    if (!this.isPreview) {
      container.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = widgetPos(view, container);
        if (pos === null) return;
        const targetPos = Math.min(pos + 2, view.state.doc.length);
        view.dispatch({
          selection: { anchor: targetPos, head: targetPos },
        });
        view.focus();
      });
    }

    return container;
  }
}

export interface MathFormulaNode {
  kind: "inline" | "block";
  from: number;
  to: number;
  tex: string;
  openMark: { from: number; to: number };
  closeMark: { from: number; to: number } | null;
}

/**
 * Math formulas in the document, or only those overlapping `[from, to]`.
 * The range form is what the incremental decoration pass uses.
 */
export function collectMathFormulas(
  state: EditorState,
  from = 0,
  to: number = state.doc.length,
): MathFormulaNode[] {
  return collectMathFormulasWithTree(state, from, to).formulas;
}

function collectMathFormulasWithTree(
  state: EditorState,
  from: number,
  to: number,
): { formulas: MathFormulaNode[]; parsedTo: number } {
  const tree = ensureSyntaxTree(state, to, 100) ?? syntaxTree(state);
  const formulas: MathFormulaNode[] = [];

  tree.iterate({
    from,
    to,
    enter: (nodeRef) => {
      if (
        nodeRef.name === "FencedCode" ||
        nodeRef.name === "CodeBlock" ||
        nodeRef.name === "InlineCode"
      ) {
        return false;
      }

      if (nodeRef.name === "InlineMath") {
        const marks = nodeRef.node.getChildren("InlineMathMark");
        if (marks.length < 2) return false;
        const openMark = { from: marks[0].from, to: marks[0].to };
        const closeMark = {
          from: marks[marks.length - 1].from,
          to: marks[marks.length - 1].to,
        };
        const tex = state.sliceDoc(openMark.to, closeMark.from);
        formulas.push({
          kind: "inline",
          from: nodeRef.from,
          to: nodeRef.to,
          tex,
          openMark,
          closeMark,
        });
        return false;
      }

      if (nodeRef.name === "BlockMath") {
        const marks = nodeRef.node.getChildren("BlockMathMark");
        if (marks.length < 1) return false;
        const openMark = { from: marks[0].from, to: marks[0].to };
        const closeMark =
          marks.length > 1
            ? {
                from: marks[marks.length - 1].from,
                to: marks[marks.length - 1].to,
              }
            : null;
        const texFrom = openMark.to;
        const texTo = closeMark ? closeMark.from : nodeRef.to;
        const tex = state.sliceDoc(texFrom, Math.max(texFrom, texTo));
        formulas.push({
          kind: "block",
          from: nodeRef.from,
          to: nodeRef.to,
          tex,
          openMark,
          closeMark,
        });
        return false;
      }
    },
  });

  return { formulas, parsedTo: tree.length };
}

/** Decorations for one formula. `startEquationNumber` only matters with auto-numbering. */
function decorateFormula(
  state: EditorState,
  formula: MathFormulaNode,
  out: Array<Range<Decoration>>,
  autoNumber: boolean,
  startEquationNumber: number,
): void {
  const engineReady = mathEngineInstance !== null;
  if (formula.kind === "inline") {
    const active = isSelectionTouchingRange(
      state.selection,
      formula.from,
      formula.to,
    );
    if (active) {
      out.push(
        Decoration.mark({ class: "k-mark" }).range(
          formula.openMark.from,
          formula.openMark.to,
        ),
      );
      if (formula.closeMark && formula.closeMark.from > formula.openMark.to) {
        out.push(
          Decoration.mark({ class: "k-math-source" }).range(
            formula.openMark.to,
            formula.closeMark.from,
          ),
        );
        out.push(
          Decoration.mark({ class: "k-mark" }).range(
            formula.closeMark.from,
            formula.closeMark.to,
          ),
        );
      }
    } else {
      out.push(
        Decoration.replace({
          widget: new InlineMathWidget(formula.tex, engineReady),
        }).range(formula.from, formula.to),
      );
    }
    return;
  }

  const startLine = state.doc.lineAt(formula.from);
  const endLine = state.doc.lineAt(formula.to);
  const active = isSelectionTouchingRange(
    state.selection,
    startLine.from,
    endLine.to,
  );

  if (active) {
    for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
      const line = state.doc.line(lineNo);
      out.push(
        Decoration.line({ class: "k-math-block-source-line" }).range(line.from),
      );
    }
    out.push(
      Decoration.mark({ class: "k-mark" }).range(
        formula.openMark.from,
        formula.openMark.to,
      ),
    );
    if (formula.closeMark) {
      out.push(
        Decoration.mark({ class: "k-mark" }).range(
          formula.closeMark.from,
          formula.closeMark.to,
        ),
      );
    }
    out.push(
      Decoration.widget({
        widget: new BlockMathWidget(
          formula.tex,
          true,
          engineReady,
          autoNumber,
          startEquationNumber,
        ),
        block: true,
        side: 1,
      }).range(endLine.to),
    );
  } else {
    out.push(
      Decoration.replace({
        widget: new BlockMathWidget(
          formula.tex,
          false,
          engineReady,
          autoNumber,
          startEquationNumber,
        ),
        block: true,
      }).range(startLine.from, endLine.to),
    );
  }
}

/** Full rebuild: every formula in the document (typesetting stays lazy). */
export function buildMathDecorations(state: EditorState): DecorationSet {
  return buildAllMathDecorations(state).decorations;
}

function buildAllMathDecorations(state: EditorState): {
  decorations: DecorationSet;
  parsedTo: number;
} {
  const { formulas, parsedTo } = collectMathFormulasWithTree(
    state,
    0,
    state.doc.length,
  );
  if (formulas.length === 0) {
    return { decorations: Decoration.none, parsedTo };
  }

  const autoNumber = state.facet(mathAutoNumberFacet);
  const decorations: Array<Range<Decoration>> = [];
  let nextEquationNumber = 1;

  for (const formula of formulas) {
    decorateFormula(
      state,
      formula,
      decorations,
      autoNumber,
      nextEquationNumber,
    );
    if (formula.kind === "block" && autoNumber && mathEngineInstance) {
      nextEquationNumber += equationCountFor(formula.tex, nextEquationNumber);
    }
  }

  return { decorations: Decoration.set(decorations, true), parsedTo };
}

interface PosRange {
  from: number;
  to: number;
}

export interface MathFieldValue {
  decorations: DecorationSet;
  /** Ranges edited during IME composition, rebuilt once composition ends. */
  dirty: readonly PosRange[];
  /** A full rebuild was requested during composition. */
  dirtyAll: boolean;
  /** Extent of the syntax tree when decorations were last built. */
  parsedTo: number;
}

/** Re-render the math decorations (dispatched on compositionend). */
export const mathRefreshEffect = StateEffect.define<null>();

// Lines containing these may re-structure the document far beyond the edit
// (opening/closing a `$$` block or a code fence), so they force a full rebuild.
const STRUCTURAL_MARKERS = /\$\$|```|~~~/;

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

/** Expands `[from, to]` to whole top-level blocks (paragraph, `$$` block, list…). */
function expandToBlocks(
  state: EditorState,
  from: number,
  to: number,
): PosRange {
  const tree = syntaxTree(state);
  const topLevelAt = (pos: number, side: -1 | 1): PosRange | null => {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node?.parent?.parent) {
      node = node.parent;
    }
    if (!node || !node.parent) return null;
    return { from: node.from, to: node.to };
  };
  let start = state.doc.lineAt(from).from;
  let end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  const a = topLevelAt(from, 1);
  const b = topLevelAt(Math.min(to, state.doc.length), -1);
  if (a && a.from <= from && a.to >= from) start = Math.min(start, a.from);
  if (b && b.from <= to && b.to >= to) end = Math.max(end, b.to);
  start = state.doc.lineAt(start).from;
  end = state.doc.lineAt(end).to;
  return { from: start, to: end };
}

function mergeRanges(ranges: PosRange[]): PosRange[] {
  const sorted = [...ranges].sort((x, y) => x.from - y.from);
  const merged: PosRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Rebuilds decorations only inside `regions`; everything else is kept (already mapped). */
function rebuildRegions(
  state: EditorState,
  decorations: DecorationSet,
  regions: PosRange[],
): DecorationSet {
  const expanded = mergeRanges(
    regions.map((r) =>
      expandToBlocks(
        state,
        Math.max(0, Math.min(r.from, state.doc.length)),
        Math.max(0, Math.min(r.to, state.doc.length)),
      ),
    ),
  );
  let result = decorations;
  for (const region of expanded) {
    const formulas = collectMathFormulas(state, region.from, region.to);
    let from = region.from;
    let to = region.to;
    for (const f of formulas) {
      from = Math.min(from, state.doc.lineAt(f.from).from);
      to = Math.max(to, state.doc.lineAt(f.to).to);
    }
    const add: Array<Range<Decoration>> = [];
    for (const f of formulas) {
      decorateFormula(state, f, add, false, 1);
    }
    result = result.update({
      filterFrom: from,
      filterTo: to,
      filter: (f, t) => !((f >= from && t <= to) || (f < to && t > from)),
      add,
      sort: true,
    });
  }
  return result;
}

function selectionRanges(selection: EditorSelection): PosRange[] {
  return selection.ranges.map((r) => ({ from: r.from, to: r.to }));
}

function fullValue(state: EditorState): MathFieldValue {
  const { decorations, parsedTo } = buildAllMathDecorations(state);
  return { decorations, dirty: [], dirtyAll: false, parsedTo };
}

export const mathStateField = StateField.define<MathFieldValue>({
  create(state) {
    return fullValue(state);
  },
  update(value, tr) {
    const engineLoaded = tr.effects.some((e) => e.is(mathEngineLoadedEffect));
    const refresh = tr.effects.some((e) => e.is(mathRefreshEffect));
    const composing = tr.isUserEvent("input.type.compose");
    const autoNumber = tr.state.facet(mathAutoNumberFacet);

    // IME composition (AC9): never re-render while composing; just map.
    if (composing) {
      const dirty: PosRange[] = value.dirty.map((r) => ({
        from: mapPosClamped(tr.changes, r.from, -1),
        to: mapPosClamped(tr.changes, r.to, 1),
      }));
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        dirty.push({ from: fromB, to: toB });
      });
      return {
        decorations: value.decorations.map(tr.changes),
        dirty,
        dirtyAll: value.dirtyAll || (tr.docChanged && isStructuralChange(tr)),
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
      !engineLoaded &&
      !treeChanged &&
      !(refresh && pendingDirty)
    ) {
      return value;
    }

    // Auto-numbering makes every block depend on all blocks before it, so
    // keep the simple full rebuild there. Same for engine load / reconfigure
    // and edits that open or close a `$$` block or code fence.
    if (
      engineLoaded ||
      tr.reconfigured ||
      value.dirtyAll ||
      autoNumber ||
      (tr.docChanged && isStructuralChange(tr))
    ) {
      return fullValue(tr.state);
    }

    let decorations = value.decorations.map(tr.changes);
    const regions: PosRange[] = value.dirty.map((r) => ({
      from: mapPosClamped(tr.changes, r.from, -1),
      to: mapPosClamped(tr.changes, r.to, 1),
    }));
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      regions.push({ from: fromB, to: toB });
    });
    if (tr.selection || tr.docChanged) {
      // Only formulas under the old and new selection change active state.
      for (const r of selectionRanges(tr.startState.selection)) {
        regions.push({
          from: mapPosClamped(tr.changes, r.from, -1),
          to: mapPosClamped(tr.changes, r.to, 1),
        });
      }
      regions.push(...selectionRanges(tr.state.selection));
    }

    // Background parsing reached text that had no tree yet: decorate it.
    const parsedNow = syntaxTree(tr.state).length;
    let parsedTo = mapPosClamped(tr.changes, value.parsedTo, 1);
    if (parsedNow > parsedTo) {
      regions.push({ from: parsedTo, to: parsedNow });
      parsedTo = parsedNow;
    }

    if (regions.length > 0) {
      decorations = rebuildRegions(tr.state, decorations, regions);
    }
    return { decorations, dirty: [], dirtyAll: false, parsedTo };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

export const mathLoaderPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.maybeLoad(view.state);
    }

    maybeLoad(state: EditorState): void {
      if (mathEngineInstance) return;
      const value = state.field(mathStateField, false);
      if (value && value.decorations.size > 0) {
        void ensureMathJaxLoaded(this.view);
      }
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.transactions.length > 0) {
        this.maybeLoad(update.state);
      }
    }

    destroy(): void {
      pendingViews.delete(this.view);
    }
  },
  {
    eventHandlers: {
      compositionend(_event, view) {
        // Composition finished: render what was typed (deferred so the final
        // composition transaction has been applied first).
        queueMicrotask(() => {
          if (view.composing) return;
          const value = view.state.field(mathStateField, false);
          if (value && (value.dirty.length > 0 || value.dirtyAll)) {
            view.dispatch({ effects: mathRefreshEffect.of(null) });
          }
        });
        return false;
      },
    },
  },
);

export const mathExtension: Extension = [mathStateField, mathLoaderPlugin];
