/**
 * #144: Copy as Rich Text / HTML for pasting into Medium, Facebook, Gmail,
 * Google Docs, Notion, etc.
 *
 * Reuses the Markdown AST and rendering pipeline in `src/export/html.ts`,
 * emitting a clean HTML fragment with minimal inline styles (no `<style>`
 * block, no theme CSS variables):
 * - Code blocks: monospace font, preserved newlines (`white-space:pre-wrap`),
 *   and inline token colors.
 * - Tables: collapsed borders, cell padding, header background, column alignment.
 * - Math (`$...$` / `$$...$$`): MathJax SVG rasterized to 2x PNG `data:` URI
 *   (best cross-app paste compatibility — Gmail/Google Docs strip inline `<svg>`
 *   and `data:image/svg+xml`), with TeX `alt` text and graceful fallback to
 *   TeX `<code>` when rasterization or MathJax fails.
 * - Diagrams (`mermaid` / `flow` / `sequence`): light print-theme SVG rasterized
 *   to 2x PNG `data:` URI on a white background (falling back to SVG `<img>`).
 * - Local images: uploaded via the user's configured `uploadCommand` when set
 *   (without mutating the open `.md` document); otherwise embedded as `data:`
 *   URIs within per-image (2 MB) and total (8 MB) size limits, reporting counts
 *   so the status bar informs the user.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { nestTocEntries } from "../editor/blocks";
import { findTyporaRootUrlInText } from "../editor/image-attrs";
import { resolveImageRoot, resolveImageSrc } from "../editor/images";
import { ensureMathJaxLoaded } from "../editor/math";
import { t } from "../i18n";
import {
  appErrorDetail,
  type ImageDataUriResult,
  MAX_IMAGE_DATA_URI_BYTES,
  readImageDataUri,
  type UploadResult,
} from "../ipc";
import {
  collectExportImageHrefs,
  createExportParseState,
  escapeHtml,
  type MathRenderer,
  type RenderFormatHooks,
  renderMarkdownBody,
} from "./html";

/** Per-image size limit for `data:` URI embedding (2 MB). */
export const RICH_TEXT_MAX_IMAGE_BYTES = MAX_IMAGE_DATA_URI_BYTES;
/** Total embedded local image budget for one copy operation (8 MB). */
export const RICH_TEXT_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
/** Scale factor for rasterizing MathJax & Mermaid SVGs to crisp Retina PNGs. */
const RASTER_SCALE = 2;
/** Cap rasterized canvas dimension on either axis so huge diagrams stay fast. */
const MAX_RASTER_SIDE_PX = 2400;
/** CSS px per `ex` for MathJax SVG sizing (calibrated for 16px body text). */
const MATH_EX_PX = 8.5;
const MATH_INK_COLOR = "#1f2328";

const MONO_FONT =
  "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace";

const INLINE_CODE_STYLE = `font-family:${MONO_FONT};background-color:#f3f4f6;padding:0.15em 0.35em;border-radius:3px;font-size:0.9em;`;
const PRE_STYLE = `font-family:${MONO_FONT};font-size:13px;line-height:1.5;background-color:#f6f8fa;border:1px solid #e5e7eb;border-radius:4px;padding:12px 14px;white-space:pre-wrap;overflow-x:auto;`;
const BLOCKQUOTE_STYLE =
  "margin:0.8em 0;padding:0.2em 1em;border-left:3px solid #d1d5db;color:#4b5563;";
const TABLE_STYLE = "border-collapse:collapse;margin:0.8em 0;";
const TH_BASE_STYLE =
  "border:1px solid #d1d5db;padding:6px 10px;background-color:#f6f8fa;font-weight:600;";
const TD_BASE_STYLE = "border:1px solid #d1d5db;padding:6px 10px;";
const HR_STYLE = "border:0;border-top:1px solid #d1d5db;margin:1.2em 0;";
const PLACEHOLDER_STYLE = "color:#6e6355;font-style:italic;";
const ERROR_STYLE = "color:#a4552f;font-size:0.9em;";

/** Inline token styles matching Kalamos Papyros print syntax colors. */
const TOKEN_INLINE_STYLES: Record<string, string> = {
  "k-tok-keyword": "color:#a4552f;font-weight:600;",
  "k-tok-string": "color:#5e7a4a;",
  "k-tok-comment": "color:#6e6355;font-style:italic;",
  "k-tok-number": "color:#8a4b2d;",
  "k-tok-function": "color:#50613f;",
  "k-tok-type": "color:#82673b;",
  "k-tok-operator": "color:#5f564b;",
  "k-tok-property": "color:#4d3f35;",
};

function formatRichCodeToken(text: string, classes: string): string {
  const escaped = escapeHtml(text);
  if (!classes) return escaped;
  for (const cls of classes.split(/\s+/)) {
    const style = TOKEN_INLINE_STYLES[cls];
    if (style) return `<span style="${style}">${escaped}</span>`;
  }
  return escaped;
}

export interface RichTextSource {
  /** Markdown text with leading YAML front matter removed (also used for `text/plain`). */
  markdown: string;
  scope: "selection" | "document";
  /** `typora-root-url` from the full document's front matter (preserved even when stripped). */
  frontMatterImageRoot: string | null;
}

/**
 * Compute the byte/char offset right after leading YAML front matter (and any
 * blank lines immediately separating it from the body), or 0 if none exists.
 */
export function frontMatterBodyStart(doc: string): {
  frontMatterEnd: number;
  bodyStart: number;
} {
  const state = createExportParseState(doc);
  const tree =
    ensureSyntaxTree(state, state.doc.length, 10_000) ?? syntaxTree(state);
  const first = tree.topNode.firstChild;
  if (first?.name !== "FrontMatter" || first.from !== 0) {
    return { frontMatterEnd: 0, bodyStart: 0 };
  }
  const rest = doc.slice(first.to);
  const trailingNewlines = /^(?:\r?\n)+/.exec(rest)?.[0].length ?? 0;
  return {
    frontMatterEnd: first.to,
    bodyStart: first.to + trailingNewlines,
  };
}

/**
 * Strip leading YAML front matter from a Markdown string.
 */
export function stripLeadingFrontMatter(doc: string): string {
  const { bodyStart } = frontMatterBodyStart(doc);
  return bodyStart > 0 ? doc.slice(bodyStart) : doc;
}

/**
 * Extract the Markdown to copy from an editor state:
 * - Non-empty selection -> selected text only (with any leading document front matter excluded).
 * - Empty selection -> whole document (with leading YAML front matter excluded).
 */
export function extractRichTextSource(state: EditorState): RichTextSource {
  const fullDoc = state.doc.toString();
  const frontMatterImageRoot = findTyporaRootUrlInText(fullDoc);
  const { frontMatterEnd, bodyStart } = frontMatterBodyStart(fullDoc);
  const nonEmpty = state.selection.ranges.filter((r) => r.from < r.to);

  if (nonEmpty.length === 0) {
    return {
      markdown: bodyStart > 0 ? fullDoc.slice(bodyStart) : fullDoc,
      scope: "document",
      frontMatterImageRoot,
    };
  }

  const slices: string[] = [];
  for (const r of nonEmpty) {
    if (frontMatterEnd > 0 && r.to <= frontMatterEnd) continue;
    const from = frontMatterEnd > 0 && r.from < bodyStart ? bodyStart : r.from;
    if (from < r.to) {
      slices.push(fullDoc.slice(from, r.to));
    }
  }
  return {
    markdown: slices.join("\n\n"),
    scope: "selection",
    frontMatterImageRoot,
  };
}

// ---------------------------------------------------------------------------
// SVG → PNG rasterization (for MathJax formulas and Mermaid diagrams)
// ---------------------------------------------------------------------------

export interface RasterizedImage {
  dataUri: string;
  width: number;
  height: number;
}

export type SvgRasterizer = (
  svg: string,
  options: { width: number; height: number; background: string | null },
) => Promise<RasterizedImage | null>;

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(""));
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

/** Extract concrete SVG dimensions from `viewBox`, `max-width`, or `width`/`height`. */
export function parseSvgDimensions(svg: string): {
  width: number;
  height: number;
} | null {
  const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!openTag) return null;

  const vb =
    /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(
      openTag,
    );
  if (vb) {
    const w = Number.parseFloat(vb[1]);
    const h = Number.parseFloat(vb[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: Math.ceil(w), height: Math.ceil(h) };
    }
  }

  const wAttr = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(openTag);
  const hAttr = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(openTag);
  if (wAttr && hAttr) {
    const w = Number.parseFloat(wAttr[1]);
    const h = Number.parseFloat(hAttr[1]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: Math.ceil(w), height: Math.ceil(h) };
    }
  }
  return null;
}

/**
 * Extract the `<svg>` from MathJax's `<mjx-container>` output and normalize it
 * with explicit pixel dimensions and dark ink color for standalone rasterization.
 */
export function prepareMathJaxSvg(svgHtml: string): {
  svg: string;
  width: number;
  height: number;
  verticalAlignPx: number | null;
} | null {
  const match = /<svg\b[\s\S]*?<\/svg>/i.exec(svgHtml);
  if (!match) return null;
  let svg = match[0];
  const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!openTag) return null;

  const wEx = /\bwidth\s*=\s*["']([\d.]+)ex["']/i.exec(openTag);
  const hEx = /\bheight\s*=\s*["']([\d.]+)ex["']/i.exec(openTag);
  let width: number;
  let height: number;
  if (wEx && hEx) {
    width = Math.max(1, Math.round(Number.parseFloat(wEx[1]) * MATH_EX_PX));
    height = Math.max(1, Math.round(Number.parseFloat(hEx[1]) * MATH_EX_PX));
  } else {
    const dims = parseSvgDimensions(svg);
    if (!dims) return null;
    // MathJax viewBox units are roughly 500 per ex.
    width = Math.max(1, Math.round((dims.width / 500) * MATH_EX_PX));
    height = Math.max(1, Math.round((dims.height / 500) * MATH_EX_PX));
  }

  const vaMatch = /vertical-align:\s*(-?[\d.]+)ex/i.exec(openTag);
  const verticalAlignPx = vaMatch
    ? Math.round(Number.parseFloat(vaMatch[1]) * MATH_EX_PX * 10) / 10
    : null;

  let nextOpen = openTag
    .replace(/\s+width\s*=\s*["'][^"']*["']/i, "")
    .replace(/\s+height\s*=\s*["'][^"']*["']/i, "");
  if (!/\bxmlns\s*=/i.test(nextOpen)) {
    nextOpen = nextOpen.replace(
      /^<svg/i,
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
  }
  nextOpen = nextOpen.replace(
    /^<svg/i,
    `<svg width="${width}" height="${height}"`,
  );
  svg = `${nextOpen}${svg.slice(openTag.length)}`.replace(
    /currentColor/g,
    MATH_INK_COLOR,
  );
  return { svg, width, height, verticalAlignPx };
}

/** Normalize a Mermaid/diagram SVG so it has explicit pixel width/height and xmlns. */
export function prepareDiagramSvg(svg: string): {
  svg: string;
  width: number;
  height: number;
} | null {
  const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!openTag) return null;
  const dims = parseSvgDimensions(svg);
  if (!dims) return null;
  let nextOpen = openTag
    .replace(/\s+width\s*=\s*["'][^"']*["']/i, "")
    .replace(/\s+height\s*=\s*["'][^"']*["']/i, "");
  if (!/\bxmlns\s*=/i.test(nextOpen)) {
    nextOpen = nextOpen.replace(
      /^<svg/i,
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
  }
  nextOpen = nextOpen.replace(
    /^<svg/i,
    `<svg width="${dims.width}" height="${dims.height}"`,
  );
  return {
    svg: `${nextOpen}${svg.slice(openTag.length)}`,
    width: dims.width,
    height: dims.height,
  };
}

/** Default browser/WebView SVG → PNG rasterizer via an offscreen `<canvas>`. */
export async function rasterizeSvgToPng(
  svg: string,
  options: { width: number; height: number; background: string | null },
): Promise<RasterizedImage | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }
  const { width, height, background } = options;
  if (width <= 0 || height <= 0) return null;

  const maxSide = Math.max(width, height);
  const scale = Math.min(RASTER_SCALE, MAX_RASTER_SIDE_PX / maxSide);
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;

  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = svgToDataUri(svg);
  });
  if (!loaded) return null;

  try {
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    }
    ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
    const dataUri = canvas.toDataURL("image/png");
    if (!dataUri.startsWith("data:image/png;base64,")) return null;
    return { dataUri, width, height };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local image resolution (upload if configured, else size-limited data URI)
// ---------------------------------------------------------------------------

export interface RichTextImageStats {
  uploaded: number;
  embedded: number;
  skipped: number;
  uploadFailed: boolean;
}

export interface BuildRichTextOptions {
  /** Path of the current document (null = untitled); resolves relative image paths. */
  docPath: string | null;
  /** Number display equations like the editor's auto-number mode. */
  mathAutoNumber?: boolean;
  /** IM-04 image root setting. */
  imageRootDir?: string | null;
  /** `typora-root-url` from the full document's front matter (used when front matter was stripped). */
  frontMatterImageRoot?: string | null;
  /** Configured image upload command (IM-05); when set, local images are uploaded first. */
  uploadCommand?: string | null;
  /** Upload callback (defaults to IPC `uploadImages` when provided by caller). */
  uploadImages?: (paths: string[]) => Promise<UploadResult>;
  /** Local image data-URI reader (defaults to IPC `readImageDataUri`). */
  readImageDataUri?: (
    path: string,
    maxBytes?: number,
  ) => Promise<ImageDataUriResult>;
  /** Per-image size limit in bytes (default 2 MB). */
  maxImageBytes?: number;
  /** Total local image embedding budget in bytes (default 8 MB). */
  maxTotalImageBytes?: number;
  /** Custom SVG rasterizer (defaults to canvas `rasterizeSvgToPng`; injectable for tests). */
  rasterizeSvg?: SvgRasterizer;
}

export interface BuildRichTextResult {
  html: string;
  plainText: string;
  images: RichTextImageStats;
}

function mergeStyle(base: string, extra: string): string {
  const b = base.trim();
  const e = extra.trim();
  if (!b) return e;
  if (!e) return b;
  const sep = b.endsWith(";") ? "" : ";";
  return `${b}${sep}${e}`;
}

/**
 * Convert Markdown into a clean rich-text HTML fragment + plain-text Markdown
 * ready for the system clipboard.
 */
export async function buildRichTextHtml(
  markdownContent: string,
  options: BuildRichTextOptions,
): Promise<BuildRichTextResult> {
  const cleanMarkdown = stripLeadingFrontMatter(markdownContent);
  const effectiveFrontMatterRoot =
    options.frontMatterImageRoot !== undefined
      ? options.frontMatterImageRoot
      : findTyporaRootUrlInText(markdownContent);
  const imageRoot = resolveImageRoot(
    effectiveFrontMatterRoot,
    options.docPath,
    options.imageRootDir ?? null,
  );

  // 1. Discover every local image referenced in `cleanMarkdown`.
  const probeState = createExportParseState(cleanMarkdown);
  const probeTree =
    ensureSyntaxTree(probeState, probeState.doc.length, 10_000) ??
    syntaxTree(probeState);
  const allHrefs = collectExportImageHrefs(probeTree, cleanMarkdown);
  const localPaths: string[] = [];
  const seenLocal = new Set<string>();
  for (const href of allHrefs) {
    const resolved = resolveImageSrc(
      href,
      options.docPath,
      (p) => p,
      imageRoot,
    );
    if (resolved.kind === "local" && !seenLocal.has(resolved.path)) {
      seenLocal.add(resolved.path);
      localPaths.push(resolved.path);
    }
  }

  // 2. Resolve local images: upload if `uploadCommand` is configured, else embed data URI.
  const localSrcMap = new Map<string, string>();
  const stats: RichTextImageStats = {
    uploaded: 0,
    embedded: 0,
    skipped: 0,
    uploadFailed: false,
  };
  const pendingEmbed: string[] = [];
  const uploader = options.uploadCommand?.trim();

  if (localPaths.length > 0 && uploader && options.uploadImages) {
    try {
      for (const path of localPaths) {
        const res = await options.uploadImages([path]);
        const url = res.urls[0];
        if (res.urls.length === 1 && url && /^https?:\/\//i.test(url)) {
          localSrcMap.set(path, url);
          stats.uploaded += 1;
        } else {
          stats.uploadFailed = true;
          pendingEmbed.push(path);
        }
      }
    } catch {
      stats.uploadFailed = true;
      for (const path of localPaths) {
        if (!localSrcMap.has(path)) pendingEmbed.push(path);
      }
    }
  } else {
    pendingEmbed.push(...localPaths);
  }

  const readDataUri = options.readImageDataUri ?? readImageDataUri;
  const maxPerImage = options.maxImageBytes ?? RICH_TEXT_MAX_IMAGE_BYTES;
  const maxTotal =
    options.maxTotalImageBytes ?? RICH_TEXT_MAX_TOTAL_IMAGE_BYTES;
  let totalEmbeddedBytes = 0;

  for (const path of pendingEmbed) {
    const remaining = maxTotal - totalEmbeddedBytes;
    if (remaining <= 0) {
      stats.skipped += 1;
      continue;
    }
    try {
      const result = await readDataUri(path, Math.min(maxPerImage, remaining));
      if (
        result.status === "ok" &&
        result.dataUri &&
        result.size <= remaining
      ) {
        localSrcMap.set(path, result.dataUri);
        totalEmbeddedBytes += result.size;
        stats.embedded += 1;
      } else {
        stats.skipped += 1;
      }
    } catch {
      stats.skipped += 1;
    }
  }

  // Track references whose local path could not be resolved (e.g. unsaved relative path).
  const rasterize = options.rasterizeSvg ?? rasterizeSvgToPng;
  const rasterizedDiagrams = new Map<number, RasterizedImage | null>();
  const countedUnresolved = new Set<string>();

  // 3. Prepare MathJax SVG -> PNG rasterizer for inline & block math.
  const prepareMath = async (
    formulas: ReadonlyArray<{ tex: string; display: boolean }>,
    autoNumber: boolean,
  ): Promise<MathRenderer> => {
    const engine =
      formulas.length > 0
        ? await ensureMathJaxLoaded().catch(() => null)
        : null;
    // Key by (display, tex) with a FIFO queue so footnote definitions rendered at
    // the end of the document never swap formulas with the document body.
    const queues = new Map<string, string[]>();
    let equationCount = 0;

    for (const { tex, display } of formulas) {
      const key = `${display ? "B" : "I"}:${tex}`;
      const push = (html: string) => {
        const list = queues.get(key);
        if (list) list.push(html);
        else queues.set(key, [html]);
      };
      const trimmed = tex.trim();
      const rawSource = escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
      const fallback = display
        ? `<pre style="${PRE_STYLE}"><code style="font-family:inherit;white-space:pre-wrap;">${rawSource}</code></pre>`
        : `<code style="${INLINE_CODE_STYLE}">${rawSource}</code>`;
      if (!engine) {
        push(fallback);
        continue;
      }
      const res = engine.render(tex, display, autoNumber, equationCount + 1);
      if (res.error || !res.svgHtml) {
        push(fallback);
        continue;
      }
      equationCount += res.equationNumbers.length;
      const prepared = prepareMathJaxSvg(res.svgHtml);
      if (!prepared) {
        push(fallback);
        continue;
      }
      const png = await rasterize(prepared.svg, {
        width: prepared.width,
        height: prepared.height,
        background: null,
      });
      if (!png) {
        push(fallback);
        continue;
      }
      if (display) {
        push(
          `<p style="text-align:center;margin:0.8em 0;"><img src="${png.dataUri}" alt="${escapeHtml(trimmed)}" width="${png.width}" height="${png.height}" style="max-width:100%;height:auto;"></p>`,
        );
      } else {
        const va =
          prepared.verticalAlignPx !== null
            ? `vertical-align:${prepared.verticalAlignPx}px;`
            : "vertical-align:middle;";
        push(
          `<img src="${png.dataUri}" alt="${escapeHtml(trimmed)}" width="${png.width}" height="${png.height}" style="${va}display:inline;">`,
        );
      }
    }

    return (tex, display) => {
      const key = `${display ? "B" : "I"}:${tex}`;
      const queued = queues.get(key)?.shift();
      if (queued !== undefined) return queued;
      const raw = escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
      return display
        ? `<pre style="${PRE_STYLE}"><code style="font-family:inherit;white-space:pre-wrap;">${raw}</code></pre>`
        : `<code style="${INLINE_CODE_STYLE}">${raw}</code>`;
    };
  };

  // 4. Configure clean rich-text rendering hooks.
  const hooks: RenderFormatHooks = {
    renderHeading: (level, _id, innerHtml) =>
      `<h${level}>${innerHtml}</h${level}>\n`,
    renderInlineCode: (innerHtml) =>
      `<code style="${INLINE_CODE_STYLE}">${innerHtml}</code>`,
    renderCodeBlock: (codeHtml, _lang) =>
      `<pre style="${PRE_STYLE}"><code style="font-family:inherit;white-space:pre-wrap;">${codeHtml}</code></pre>\n`,
    renderRawHtmlBlock: (escapedHtml) =>
      `<pre style="${PRE_STYLE}">${escapedHtml}</pre>\n`,
    renderBlockquote: (innerHtml) =>
      `<blockquote style="${BLOCKQUOTE_STYLE}">\n${innerHtml}</blockquote>\n`,
    renderHorizontalRule: () => `<hr style="${HR_STYLE}">\n`,
    renderTaskItem: (checked, innerHtml) =>
      `<li style="list-style:none;">${checked ? "☑" : "☐"} ${innerHtml}</li>\n`,
    renderUnsafeLink: (labelHtml) => `<span>${labelHtml}</span>`,
    renderTable: (headerCells, bodyRows, aligns) => {
      const renderRow = (
        cells: string[],
        tag: "th" | "td",
        baseStyle: string,
      ) => {
        let out = "<tr>";
        for (let i = 0; i < cells.length; i++) {
          const align = aligns[i] ? `text-align:${aligns[i]};` : "";
          out += `<${tag} style="${baseStyle}${align}">${cells[i]}</${tag}>`;
        }
        return `${out}</tr>\n`;
      };
      let out = `<table style="${TABLE_STYLE}">\n`;
      if (headerCells) {
        out += `<thead>\n${renderRow(headerCells, "th", TH_BASE_STYLE)}</thead>\n`;
      }
      if (bodyRows.length > 0) {
        out += `<tbody>\n${bodyRows
          .map((row) => renderRow(row, "td", TD_BASE_STYLE))
          .join("")}</tbody>\n`;
      }
      return `${out}</table>\n`;
    },
    renderImage: (href, alt, title, style) => {
      const resolved = resolveImageSrc(
        href,
        options.docPath,
        (p) => p,
        imageRoot,
      );
      let src: string | null = null;
      if (resolved.kind === "remote" || resolved.kind === "data") {
        src = resolved.url;
      } else if (resolved.kind === "local") {
        src = localSrcMap.get(resolved.path) ?? null;
      } else if (resolved.kind === "needs-save") {
        if (!countedUnresolved.has(href)) {
          countedUnresolved.add(href);
          stats.skipped += 1;
        }
      }
      if (!src) {
        return `<span style="${PLACEHOLDER_STYLE}">[${escapeHtml(alt || href)}]</span>`;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      const combinedStyle = mergeStyle("max-width:100%;height:auto;", style);
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} style="${escapeHtml(combinedStyle)}">`;
    },
    renderDiagram: (svg, kind, index) => {
      const alt = `${kind || "mermaid"} diagram`;
      const png = rasterizedDiagrams.get(index);
      if (png) {
        return `<p style="text-align:center;margin:0.8em 0;"><img src="${png.dataUri}" alt="${escapeHtml(alt)}" width="${png.width}" height="${png.height}" style="max-width:100%;height:auto;"></p>\n`;
      }
      const prepared = prepareDiagramSvg(svg);
      const dataUri = svgToDataUri(prepared?.svg ?? svg);
      const sizeAttrs = prepared
        ? ` width="${prepared.width}" height="${prepared.height}"`
        : "";
      return `<p style="text-align:center;margin:0.8em 0;"><img src="${dataUri}" alt="${escapeHtml(alt)}"${sizeAttrs} style="max-width:100%;height:auto;"></p>\n`;
    },
    renderDiagramError: (message) =>
      `<p style="${ERROR_STYLE}">${escapeHtml(message)}</p>\n`,
    renderFootnoteRef: (num) => `<sup><a href="#fn-${num}">[${num}]</a></sup>`,
    renderFootnoteSection: (items) => {
      const lis = items
        .map(({ num, bodyHtml }) => `<li id="fn-${num}">${bodyHtml}</li>\n`)
        .join("");
      return `<hr style="${HR_STYLE}">\n<ol>\n${lis}</ol>\n`;
    },
    renderToc: (entries) => {
      const list = (nodes: ReturnType<typeof nestTocEntries>): string =>
        `<ul>\n${nodes
          .map(
            (n) =>
              `<li>${escapeHtml(n.text)}${
                n.children.length > 0 ? list(n.children) : ""
              }</li>\n`,
          )
          .join("")}</ul>\n`;
      return list(nestTocEntries(entries));
    },
  };

  const { body } = await renderMarkdownBody(cleanMarkdown, {
    docPath: options.docPath,
    mathAutoNumber: options.mathAutoNumber,
    imageRootDir: options.imageRootDir,
    frontMatterImageRoot: effectiveFrontMatterRoot,
    formatCodeToken: formatRichCodeToken,
    prepareMath,
    hooks,
    onDiagramsRendered: async (renderedDiagrams) => {
      for (const [i, item] of renderedDiagrams.entries()) {
        if (!item.result.svg) continue;
        const prepared = prepareDiagramSvg(item.result.svg);
        if (!prepared) continue;
        const png = await rasterize(prepared.svg, {
          width: prepared.width,
          height: prepared.height,
          background: "#ffffff",
        });
        rasterizedDiagrams.set(i, png);
      }
    },
  });

  return {
    html: body.trim(),
    plainText: cleanMarkdown,
    images: stats,
  };
}

/** Localized status bar message after a successful Copy as Rich Text. */
export function formatCopyRichTextStatus(
  scope: "selection" | "document",
  images: RichTextImageStats,
): string {
  const base = t(
    scope === "selection"
      ? "export.copyRichText.doneSelection"
      : "export.copyRichText.doneDocument",
  );
  const notes: string[] = [];
  if (images.uploadFailed) {
    notes.push(t("export.copyRichText.noteUploadFallback"));
  }
  if (images.uploaded > 0) {
    notes.push(
      t(
        images.uploaded === 1
          ? "export.copyRichText.noteUploadedOne"
          : "export.copyRichText.noteUploaded",
        { count: images.uploaded },
      ),
    );
  }
  if (images.embedded > 0) {
    notes.push(
      t(
        images.embedded === 1
          ? "export.copyRichText.noteEmbeddedOne"
          : "export.copyRichText.noteEmbedded",
        { count: images.embedded },
      ),
    );
  }
  if (images.skipped > 0) {
    notes.push(
      t(
        images.skipped === 1
          ? "export.copyRichText.noteSkippedOne"
          : "export.copyRichText.noteSkipped",
        { count: images.skipped },
      ),
    );
  }
  if (notes.length === 0) return base;
  return t("export.copyRichText.withNote", {
    base,
    note: notes.join(t("export.copyRichText.noteSeparator")),
  });
}

export function copyRichTextErrorMessage(error: unknown): string {
  return t("dialog.errorWithDetail", {
    prefix: t("export.copyRichText.failed"),
    detail: appErrorDetail(error),
  });
}
