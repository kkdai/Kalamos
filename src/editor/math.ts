import "./math.css";

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import { isSelectionTouchingRange } from "./live-preview";

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
        import("mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js"),
      ]);

      const adaptor = liteAdaptor();
      RegisterHTMLHandler(adaptor);

      let capturedError: string | null = null;
      const packages = [...ALLOWED_TEX_PACKAGES];

      const texNone = new TeX({
        packages,
        tags: "none",
        formatError: (jax: { formatError: (e: Error) => unknown }, err: Error) => {
          capturedError = err.message || "TeX syntax error";
          return jax.formatError(err);
        },
      });

      const texAms = new TeX({
        packages,
        tags: "ams",
        formatError: (jax: { formatError: (e: Error) => unknown }, err: Error) => {
          capturedError = err.message || "TeX syntax error";
          return jax.formatError(err);
        },
      });

      const svg = new SVG({ fontCache: "none" });
      const docNone = mathjax.document("", { InputJax: texNone, OutputJax: svg });
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
        const tagRe = /id="mjx-eqn:(\d+)"/g;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(html)) !== null) {
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

          let conv = runConvert(effectiveTex, display, useAms, startEquationNumber);
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

class InlineMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly result: MathRenderResult | null,
    readonly sourceFrom: number,
  ) {
    super();
  }

  eq(other: InlineMathWidget): boolean {
    return (
      this.tex === other.tex &&
      this.sourceFrom === other.sourceFrom &&
      this.result?.svgHtml === other.result?.svgHtml &&
      this.result?.error === other.result?.error
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "k-math-inline";
    span.dataset.testid = "math-inline";
    span.dataset.tex = this.tex;

    if (!this.result) {
      span.textContent = this.tex;
    } else if (this.result.error) {
      const errEl = document.createElement("span");
      errEl.className = "k-math-error";
      errEl.dataset.testid = "math-error";
      errEl.setAttribute("role", "alert");
      errEl.textContent = this.result.error;
      span.appendChild(errEl);
    } else {
      span.innerHTML = this.result.svgHtml;
    }

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = Math.min(this.sourceFrom + 1, view.state.doc.length);
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
    readonly result: MathRenderResult | null,
    readonly sourceFrom: number,
    readonly isPreview: boolean,
  ) {
    super();
  }

  eq(other: BlockMathWidget): boolean {
    return (
      this.tex === other.tex &&
      this.sourceFrom === other.sourceFrom &&
      this.isPreview === other.isPreview &&
      this.result?.svgHtml === other.result?.svgHtml &&
      this.result?.error === other.result?.error &&
      (this.result?.equationNumbers.join(",") ?? "") ===
        (other.result?.equationNumbers.join(",") ?? "")
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

    if (this.result && this.result.equationNumbers.length > 0) {
      container.dataset.equationNumber = this.result.equationNumbers.join(",");
    }

    if (!this.result) {
      container.textContent = this.tex;
    } else if (this.result.error) {
      const errEl = document.createElement("span");
      errEl.className = "k-math-error";
      errEl.dataset.testid = "math-error";
      errEl.setAttribute("role", "alert");
      errEl.textContent = this.result.error;
      container.appendChild(errEl);
    } else {
      const contentWrap = document.createElement("div");
      contentWrap.className = "k-math-svg-wrap";
      contentWrap.innerHTML = this.result.svgHtml;
      container.appendChild(contentWrap);

      if (this.result.equationNumbers.length > 0) {
        const eqBadge = document.createElement("span");
        eqBadge.className = "k-math-eq-number";
        eqBadge.dataset.testid = "math-eq-number";
        eqBadge.textContent = this.result.equationNumbers
          .map((n) => `(${n})`)
          .join(" ");
        container.appendChild(eqBadge);
      }
    }

    if (!this.isPreview) {
      container.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetPos = Math.min(this.sourceFrom + 2, view.state.doc.length);
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

export function collectMathFormulas(state: EditorState): MathFormulaNode[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const formulas: MathFormulaNode[] = [];

  tree.iterate({
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

  return formulas;
}

export function buildMathDecorations(state: EditorState): DecorationSet {
  const formulas = collectMathFormulas(state);
  if (formulas.length === 0) {
    return Decoration.none;
  }

  // Trigger dynamic MathJax load if not yet loaded
  if (!mathEngineInstance) {
    void ensureMathJaxLoaded();
  }

  const autoNumber = state.facet(mathAutoNumberFacet);
  const decorations: Array<Range<Decoration>> = [];
  let nextEquationNumber = 1;

  for (const formula of formulas) {
    if (formula.kind === "inline") {
      const active = isSelectionTouchingRange(
        state.selection,
        formula.from,
        formula.to,
      );
      if (active) {
        decorations.push(
          Decoration.mark({ class: "k-mark" }).range(
            formula.openMark.from,
            formula.openMark.to,
          ),
        );
        if (
          formula.closeMark &&
          formula.closeMark.from > formula.openMark.to
        ) {
          decorations.push(
            Decoration.mark({ class: "k-math-source" }).range(
              formula.openMark.to,
              formula.closeMark.from,
            ),
          );
          decorations.push(
            Decoration.mark({ class: "k-mark" }).range(
              formula.closeMark.from,
              formula.closeMark.to,
            ),
          );
        }
      } else {
        const result = renderTeXSync(formula.tex, false, false, 1);
        decorations.push(
          Decoration.replace({
            widget: new InlineMathWidget(formula.tex, result, formula.from),
          }).range(formula.from, formula.to),
        );
      }
    } else {
      const startLine = state.doc.lineAt(formula.from);
      const endLine = state.doc.lineAt(formula.to);
      const active = isSelectionTouchingRange(
        state.selection,
        startLine.from,
        endLine.to,
      );
      const result = renderTeXSync(
        formula.tex,
        true,
        autoNumber,
        nextEquationNumber,
      );
      if (result && result.equationNumbers.length > 0) {
        const maxNum = Math.max(...result.equationNumbers);
        nextEquationNumber = Math.max(
          nextEquationNumber + result.equationNumbers.length,
          maxNum + 1,
        );
      }

      if (active) {
        for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
          const line = state.doc.line(lineNo);
          decorations.push(
            Decoration.line({ class: "k-math-block-source-line" }).range(
              line.from,
            ),
          );
        }
        decorations.push(
          Decoration.mark({ class: "k-mark" }).range(
            formula.openMark.from,
            formula.openMark.to,
          ),
        );
        if (formula.closeMark) {
          decorations.push(
            Decoration.mark({ class: "k-mark" }).range(
              formula.closeMark.from,
              formula.closeMark.to,
            ),
          );
        }
        decorations.push(
          Decoration.widget({
            widget: new BlockMathWidget(
              formula.tex,
              result,
              startLine.from,
              true,
            ),
            block: true,
            side: 1,
          }).range(endLine.to),
        );
      } else {
        decorations.push(
          Decoration.replace({
            widget: new BlockMathWidget(
              formula.tex,
              result,
              startLine.from,
              false,
            ),
            block: true,
          }).range(startLine.from, endLine.to),
        );
      }
    }
  }

  return Decoration.set(decorations, true);
}

export const mathStateField = StateField.define<DecorationSet>({
  create(state) {
    return buildMathDecorations(state);
  },
  update(value, tr) {
    const engineLoaded = tr.effects.some((e) => e.is(mathEngineLoadedEffect));
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      engineLoaded ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildMathDecorations(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const mathLoaderPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      if (!mathEngineInstance && collectMathFormulas(view.state).length > 0) {
        void ensureMathJaxLoaded(view);
      }
    }

    update(update: ViewUpdate): void {
      if (
        !mathEngineInstance &&
        (update.docChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) &&
        collectMathFormulas(update.state).length > 0
      ) {
        void ensureMathJaxLoaded(update.view);
      }
    }
  },
);

export const mathExtension: Extension = [mathStateField, mathLoaderPlugin];
