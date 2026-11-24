/**
 * #37: Mermaid / flow / sequence fences in the PDF export.
 *
 * Diagrams go through the editor's pipeline (`renderDiagram`: flow / sequence
 * → Mermaid translation, Mermaid with securityLevel "strict" and no HTML
 * labels, DOMPurify, LRU cache), but always with the light print theme below
 * so a dark editor theme never leaks into the PDF. The export WebView runs
 * without JavaScript, so the result must be static, sanitised inline SVG.
 * Every SVG's ids are prefixed per diagram so two diagrams (even two copies
 * of the same cached SVG) never share ids or style rules.
 */
import {
  type DiagramKind,
  type DiagramRenderResult,
  diagramThemeFromColors,
  renderDiagram,
} from "../editor/diagrams";
import { t } from "../i18n";

/** Same palette as print-css.ts (white paper). */
export const PRINT_DIAGRAM_THEME = diagramThemeFromColors(
  {
    bg: "#ffffff",
    surface: "#f7f3ea",
    text: "#2b2622",
    textMuted: "#6e6355",
    accent: "#5e7a4a",
    link: "#a4552f",
    divider: "#d9cdb3",
  },
  // System fonts exist in both the app WebView (where Mermaid measures text)
  // and the export WebView (where it is drawn), so labels fit their boxes.
  '-apple-system, "PingFang TC", "Helvetica Neue", Arial, sans-serif',
);

export interface DiagramFence {
  kind: DiagramKind;
  source: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prefix every id in `svg` (and every `#id` reference: `url(#…)`, `href="#…"`,
 * CSS selectors) with `prefix`, so several SVGs can live in one page.
 */
export function scopeSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  if (ids.size === 0) return svg;
  // Longest first so `a-1` is not rewritten inside `a-10`.
  const sorted = [...ids].sort((a, b) => b.length - a.length);
  const rename = new Map(
    sorted.map((id, i) => [id, `${prefix}-${i}`] as const),
  );
  const alternatives = sorted.map(escapeRegExp).join("|");
  const idAttr = new RegExp(`(\\sid=")(${alternatives})(")`, "g");
  const ref = new RegExp(`#(${alternatives})(?![\\w-])`, "g");
  const aria = /(\saria-(?:labelledby|describedby)=")([^"]*)(")/g;
  return svg
    .replace(
      idAttr,
      (_m, a: string, id: string, b: string) => `${a}${rename.get(id)}${b}`,
    )
    .replace(ref, (_m, id: string) => `#${rename.get(id)}`)
    .replace(
      aria,
      (_m, a: string, list: string, b: string) =>
        `${a}${list
          .split(/\s+/)
          .map((id) => rename.get(id) ?? id)
          .join(" ")}${b}`,
    );
}

/** Static-safety net on top of DOMPurify: no scripts, foreignObject or handlers. */
export function isStaticSvg(svg: string): boolean {
  // Checked inside tags only, so label text such as "one = two" is fine.
  return !/<script|<foreignObject|<[^>]*\son[a-z]+\s*=|<[^>]*=\s*["']?\s*javascript:/i.test(
    svg,
  );
}

/** Render the fences in order (serialised and cached by `renderDiagram`). */
export async function renderExportDiagrams(
  fences: readonly DiagramFence[],
): Promise<DiagramRenderResult[]> {
  const results: DiagramRenderResult[] = [];
  for (const [i, fence] of fences.entries()) {
    const result = await renderDiagram(
      fence.kind,
      fence.source,
      PRINT_DIAGRAM_THEME,
    );
    if (result.error || !result.svg) {
      results.push({
        svg: "",
        error: result.error ?? t("editor.diagram.syntaxError"),
        line: result.line,
      });
      continue;
    }
    const svg = scopeSvgIds(result.svg, `k-export-diagram-${i + 1}`);
    results.push(
      isStaticSvg(svg)
        ? { svg, error: null, line: null }
        : { svg: "", error: t("export.diagram.disallowedContent"), line: null },
    );
  }
  return results;
}
