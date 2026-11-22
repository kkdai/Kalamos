/**
 * EX-02 / EX-03 helpers (issue #16): export to other formats and import
 * through Pandoc. Pure functions shared by the app shell (src/main.ts).
 */

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";
import { findTyporaRootUrlInText, parseImgTag } from "../editor/image-attrs";
import { resolveImageRoot, resolveImageSrc } from "../editor/images";
import { documentTitle } from "./pdf";

export type PandocFormat = "docx" | "odt" | "latex" | "mediawiki" | "epub";

export interface PandocFormatInfo {
  id: PandocFormat;
  label: string;
  ext: string;
  description: string;
}

export const PANDOC_FORMATS: readonly PandocFormatInfo[] = [
  { id: "docx", label: "DOCX", ext: "docx", description: "Microsoft Word" },
  {
    id: "odt",
    label: "ODT",
    ext: "odt",
    description: "OpenOffice / LibreOffice",
  },
  { id: "latex", label: "LaTeX", ext: "tex", description: "LaTeX 原始檔" },
  {
    id: "mediawiki",
    label: "MediaWiki",
    ext: "wiki",
    description: "MediaWiki 標記",
  },
  { id: "epub", label: "EPUB", ext: "epub", description: "電子書" },
];

/** Extensions `import_pandoc` accepts. */
export const PANDOC_IMPORT_EXTENSIONS = [
  "docx",
  "odt",
  "epub",
  "tex",
  "html",
  "htm",
  "wiki",
  "mediawiki",
];

export const PANDOC_MISSING_MESSAGE =
  "找不到 Pandoc：請先安裝（brew install pandoc）";
export const EXPORTING_MESSAGE = "匯出中…";
export const IMPORTING_MESSAGE = "匯入中…";

export function formatInfo(format: PandocFormat): PandocFormatInfo {
  return PANDOC_FORMATS.find((f) => f.id === format) ?? PANDOC_FORMATS[0];
}

/** Suggested save path: next to the document, same name, format extension. */
export function defaultExportPath(
  docPath: string | null,
  format: PandocFormat,
): string {
  const name = `${documentTitle(docPath)}.${formatInfo(format).ext}`;
  if (!docPath) return name;
  const idx = docPath.lastIndexOf("/");
  return idx > 0 ? `${docPath.slice(0, idx)}/${name}` : name;
}

/** Make sure the chosen path ends with the format's extension. */
export function ensureExportExtension(
  path: string,
  format: PandocFormat,
): string {
  const ext = formatInfo(format).ext;
  return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`;
}

export function exportedMessage(format: PandocFormat, path: string): string {
  return `已匯出 ${formatInfo(format).label}：${path}`;
}

export function importedMessage(path: string): string {
  return `已匯入：${path.slice(path.lastIndexOf("/") + 1)}`;
}

export function isImportablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return (
    dot > path.lastIndexOf("/") &&
    PANDOC_IMPORT_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Preparing a Kalamos document for Pandoc
// ---------------------------------------------------------------------------

export interface PreparedMarkdown {
  markdown: string;
  /** The document had a `[TOC]` line (removed; pandoc `--toc` instead). */
  toc: boolean;
  /** IM-04 image root in effect (also passed as a pandoc resource path). */
  imageRoot: string | null;
}

const identityUrl = (path: string): string => path;

/** A link destination pandoc reads as-is (angle brackets when needed). */
function destination(path: string): string {
  return /[\s()<>]/.test(path)
    ? `<${path.replace(/[<>]/g, encodeURIComponent)}>`
    : path;
}

/** Local image sources become absolute paths (root and `%20` resolved like the editor). */
function resolvedImagePath(
  src: string,
  docPath: string | null,
  root: string | null,
): string | null {
  const resolved = resolveImageSrc(src, docPath, identityUrl, root);
  return resolved.kind === "local" ? resolved.path : null;
}

/** `width` / `height` pandoc understands (px or %); em / rem / vw / zoom are dropped. */
function pandocSizeAttrs(size: { width?: string; height?: string }): string {
  const parts: string[] = [];
  for (const key of ["width", "height"] as const) {
    const value = size[key];
    if (value && /^\d+(\.\d+)?(px|%)$/.test(value))
      parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

function escapeAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

/**
 * Rewrites Kalamos-only syntax for Pandoc. The document itself is never
 * changed; this only builds the text sent to pandoc:
 * - `[TOC]` lines (outside code) are removed and reported as `toc`.
 * - Local image paths become absolute (IM-04 root / `typora-root-url`
 *   applied), so pandoc embeds the same files the editor shows.
 * - `<img>` tags become `![alt](path){width=…}` so Word / ODT / EPUB keep
 *   them (raw HTML is dropped by those writers).
 */
export function prepareMarkdownForPandoc(
  content: string,
  docPath: string | null,
  settingRoot: string | null,
): PreparedMarkdown {
  const imageRoot = resolveImageRoot(
    findTyporaRootUrlInText(content),
    docPath,
    settingRoot,
  );
  const tree = (markdownLanguage.parser as MarkdownParser).parse(content);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  let toc = false;

  tree.iterate({
    enter: (ref) => {
      const name = ref.name;
      if (
        name === "FencedCode" ||
        name === "CodeBlock" ||
        name === "InlineCode"
      )
        return false;
      if (name === "Paragraph") {
        const text = content.slice(ref.from, ref.to);
        if (/^\s*\[toc\]\s*$/i.test(text)) {
          toc = true;
          edits.push({ from: ref.from, to: ref.to, insert: "" });
          return false;
        }
        return undefined;
      }
      if (name === "Image") {
        const url = ref.node.getChild("URL");
        if (!url) return false;
        const path = resolvedImagePath(
          content.slice(url.from, url.to),
          docPath,
          imageRoot,
        );
        if (path)
          edits.push({ from: url.from, to: url.to, insert: destination(path) });
        return false;
      }
      if (name === "HTMLTag" || name === "HTMLBlock") {
        const raw = content.slice(ref.from, ref.to);
        // HTML blocks: convert only when every non-blank line is one <img>.
        const lines = raw.split("\n");
        const converted: string[] = [];
        for (const line of lines) {
          if (!line.trim()) {
            converted.push(line);
            continue;
          }
          const tag = parseImgTag(line.trim());
          if (!tag) return false;
          const path = resolvedImagePath(tag.src, docPath, imageRoot);
          const src = path ?? tag.src;
          if (!path && !/^(https?:|data:image\/)/i.test(src)) return false;
          const title = tag.title ? ` "${tag.title.replace(/"/g, '\\"')}"` : "";
          converted.push(
            `![${escapeAlt(tag.alt)}](${destination(src)}${title})${pandocSizeAttrs(tag.size)}`,
          );
        }
        edits.push({
          from: ref.from,
          to: ref.to,
          insert: converted.join("\n"),
        });
        return false;
      }
      return undefined;
    },
  });

  let markdown = content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    markdown =
      markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to);
  }
  return { markdown, toc, imageRoot };
}
