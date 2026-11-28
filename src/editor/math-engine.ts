import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/bbox/BboxConfiguration.js";
import "mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { t } from "../i18n";
import type { MathJaxEngine, MathRenderResult } from "./math";

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

export interface MathCacheOps {
  get: (key: string) => MathRenderResult | undefined;
  set: (key: string, value: MathRenderResult) => void;
}

export function createMathJaxEngine(cache: MathCacheOps): MathJaxEngine {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);

  let capturedError: string | null = null;
  const packages = [...ALLOWED_TEX_PACKAGES];

  const texNone = new TeX({
    packages,
    tags: "none",
    formatError: (jax: { formatError: (e: Error) => unknown }, err: Error) => {
      capturedError = err.message || t("editor.math.syntaxError");
      return jax.formatError(err);
    },
  });

  const texAms = new TeX({
    packages,
    tags: "ams",
    formatError: (jax: { formatError: (e: Error) => unknown }, err: Error) => {
      capturedError = err.message || t("editor.math.syntaxError");
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
    const tagRe = /id="mjx-eqn:(\d+)"/g;
    for (const m of html.matchAll(tagRe)) {
      const n = Number(m[1]);
      if (!Number.isNaN(n) && !eqNums.includes(n)) {
        eqNums.push(n);
      }
    }

    return { html, err, eqNums };
  }

  return {
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
          error: t("editor.math.empty"),
          equationNumbers: [],
        };
      }

      const useAms = display && autoNumber;
      const cacheKey = useAms
        ? `block:ams:${startEquationNumber}:${trimmed}`
        : `${display ? "block" : "inline"}:none:${trimmed}`;

      const cached = cache.get(cacheKey);
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

      cache.set(cacheKey, result);
      return result;
    },
  };
}
