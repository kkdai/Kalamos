/**
 * EX-01: turn the current Markdown document into a standalone, print-ready
 * HTML page (rendered to PDF by the Rust `export_pdf` command).
 *
 * The document is parsed with the same @lezer/markdown configuration as the
 * editor (GFM + math), heading ids are the #5 GitHub-style slugs, code is
 * highlighted with @lezer/highlight and math is rendered to SVG by the
 * editor's MathJax engine. Every piece of document text is HTML-escaped; raw
 * HTML in the document is shown as text, never interpreted.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { highlightCode } from "@lezer/highlight";
import { isTocText, nestTocEntries, type TocEntry } from "../editor/blocks";
import { cjkEmphasisExtension } from "../editor/cjk-emphasis";
import {
  papyrosHighlightStyle,
  resolveCodeLanguage,
} from "../editor/code-blocks";
import {
  type DiagramRenderResult,
  diagramErrorTitle,
  resolveDiagramKind,
} from "../editor/diagrams";
import {
  buildFootnoteIndex,
  type FootnoteIndex,
  footnoteExtension,
  footnoteIdOf,
} from "../editor/footnotes";
import { frontMatterExtension } from "../editor/front-matter";
import {
  findTyporaRootUrlInText,
  imageSizeCss,
  parseImgTag,
} from "../editor/image-attrs";
import { resolveImageRoot, resolveImageSrc } from "../editor/images";
import { collectDocumentHeadings } from "../editor/lists";
import { createMarkdownSupport } from "../editor/markdown-lang";
import { ensureMathJaxLoaded, mathMarkdownExtension } from "../editor/math";
import { t } from "../i18n";
import { type DiagramFence, renderExportDiagrams } from "./diagrams";
import { PRINT_CSS as printCss } from "./print-css";

export interface ExportHeading {
  level: number;
  text: string;
  id: string;
}

export interface ExportHtmlOptions {
  /** Shown as the HTML <title> (and the PDF document title). */
  title: string;
  /** Path of the document (null = untitled); resolves relative image paths. */
  docPath: string | null;
  /** Number display equations like the editor's auto-number mode. */
  mathAutoNumber?: boolean;
  /** IM-04 image root setting; front matter `typora-root-url` overrides it. */
  imageRootDir?: string | null;
}

export interface ExportHtmlResult {
  html: string;
  headings: ExportHeading[];
}

const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/** Syntax nodes whose text is markup, never content. */
const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "StrikethroughMark",
  "SubscriptMark",
  "SuperscriptMark",
  "InlineMathMark",
  "BlockMathMark",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "CodeInfo",
  "TableDelimiter",
  "Comment",
  "ProcessingInstruction",
  "FootnoteMark",
  "FrontMatterMark",
]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Local file path → file:// URL (the export WebView may read local files). */
export function fileUrlFromPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(?:\/(.*))?$/.exec(norm);
  if (drive) {
    const rest = (drive[2] ?? "")
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `file:///${drive[1]}:/${rest}`;
  }
  return `file://${norm
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|#)/i.test(href.trim());
}

function unwrapDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unquoteTitle(raw: string): string {
  const t = raw.trim();
  return t.length >= 2 ? t.slice(1, -1) : t;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

type CodeHighlighter = (code: string, info: string) => string;

export type CodeTokenFormatter = (text: string, classes: string) => string;

const DEFAULT_TOKEN_FORMATTER: CodeTokenFormatter = (text, classes) =>
  classes
    ? `<span class="${escapeHtml(classes)}">${escapeHtml(text)}</span>`
    : escapeHtml(text);

/** Load every language used by a fenced block, then return a sync highlighter. */
export async function prepareCodeHighlighter(
  infos: string[],
  formatToken: CodeTokenFormatter = DEFAULT_TOKEN_FORMATTER,
): Promise<CodeHighlighter> {
  const parsers = new Map<string, import("@lezer/common").Parser>();
  for (const info of new Set(infos)) {
    const desc = resolveCodeLanguage(info);
    if (!desc) continue;
    try {
      const support = desc.support ?? (await desc.load());
      parsers.set(info, support.language.parser);
    } catch {
      // Unknown / failed language: plain text.
    }
  }
  return (code, info) => {
    const parser = parsers.get(info);
    if (!parser) return escapeHtml(code);
    let out = "";
    highlightCode(
      code,
      parser.parse(code),
      papyrosHighlightStyle,
      (text, classes) => {
        out += formatToken(text, classes);
      },
      () => {
        out += "\n";
      },
    );
    return out;
  };
}

export type MathRenderer = (tex: string, display: boolean) => string;

async function prepareMathRenderer(
  hasMath: boolean,
  autoNumber: boolean,
): Promise<MathRenderer> {
  const engine = hasMath ? await ensureMathJaxLoaded().catch(() => null) : null;
  let equationCount = 0;
  return (tex, display) => {
    const source = escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
    if (!engine) return `<code class="k-math-error">${source}</code>`;
    const result = engine.render(tex, display, autoNumber, equationCount + 1);
    if (result.error || !result.svgHtml) {
      return `<code class="k-math-error" title="${escapeHtml(result.error ?? "")}">${source}</code>`;
    }
    equationCount += result.equationNumbers.length;
    return display
      ? `<div class="k-math-block">${result.svgHtml}</div>`
      : `<span class="k-math-inline">${result.svgHtml}</span>`;
  };
}

/** Optional rendering hooks used to adapt the export pipeline for rich-text paste (#144). */
export interface RenderFormatHooks {
  /** Render an image (markdown or allow-listed `<img>` tag). */
  renderImage?: (
    href: string,
    alt: string,
    title: string,
    style: string,
  ) => string;
  /** Render a successfully rendered diagram SVG. */
  renderDiagram?: (svg: string, kind: string, index: number) => string;
  /** Render a diagram error message below its code block. */
  renderDiagramError?: (message: string) => string;
  /** Render a heading; default includes GitHub slug `id`. */
  renderHeading?: (
    level: number,
    id: string | null,
    innerHtml: string,
  ) => string;
  /** Render inline code. */
  renderInlineCode?: (innerHtml: string) => string;
  /** Render a code block (fenced or indented). */
  renderCodeBlock?: (codeHtml: string, lang: string) => string;
  /** Render raw HTML blocks (escaped text). */
  renderRawHtmlBlock?: (escapedHtml: string) => string;
  /** Render a blockquote. */
  renderBlockquote?: (innerHtml: string) => string;
  /** Render a horizontal rule. */
  renderHorizontalRule?: () => string;
  /** Render a task list item (`<li>...</li>`). */
  renderTaskItem?: (checked: boolean, innerHtml: string) => string;
  /** Render a table. */
  renderTable?: (
    headerCells: string[] | null,
    bodyRows: string[][],
    aligns: string[],
  ) => string;
  /** Render an unsafe/missing link fallback. */
  renderUnsafeLink?: (labelHtml: string) => string;
  /** Render a footnote superscript reference. */
  renderFootnoteRef?: (num: number, first: boolean) => string;
  /** Render the footnotes section at the end of the document. */
  renderFootnoteSection?: (
    items: Array<{ num: number; bodyHtml: string }>,
  ) => string;
  /** Render `[TOC]`. */
  renderToc?: (entries: TocEntry[]) => string;
}

class Renderer {
  private headingIndex = 0;
  private diagramIndex = 0;
  private readonly referencedFootnotes = new Set<string>();

  constructor(
    private readonly doc: string,
    private readonly headings: ExportHeading[],
    private readonly docPath: string | null,
    private readonly highlight: CodeHighlighter,
    private readonly math: MathRenderer,
    private readonly footnotes: FootnoteIndex,
    private readonly root: SyntaxNode,
    private readonly imageRoot: string | null = null,
    /** Rendered diagrams by FencedCode node start. */
    private readonly diagrams: ReadonlyMap<
      number,
      DiagramRenderResult
    > = new Map(),
    private readonly hooks: RenderFormatHooks = {},
  ) {}

  private footnoteReference(node: SyntaxNode): string {
    const raw = this.slice(node.from, node.to);
    const id = footnoteIdOf(raw);
    const n = this.footnotes.numbers.get(id);
    if (!n) return escapeHtml(raw);
    const first = !this.referencedFootnotes.has(id);
    this.referencedFootnotes.add(id);
    if (this.hooks.renderFootnoteRef) {
      return this.hooks.renderFootnoteRef(n, first);
    }
    const idAttr = first ? ` id="fnref-${n}"` : "";
    return `<sup class="k-fn-ref"${idAttr}><a href="#fn-${n}">${n}</a></sup>`;
  }

  /** `[TOC]`: nested list of links to the headings. */
  private toc(): string {
    const entries: TocEntry[] = this.headings.map((h) => ({
      level: h.level,
      text: h.text,
      slug: h.id,
    }));
    if (entries.length === 0) return "";
    if (this.hooks.renderToc) return this.hooks.renderToc(entries);
    const list = (nodes: ReturnType<typeof nestTocEntries>): string =>
      `<ul>\n${nodes
        .map(
          (n) =>
            `<li><a href="#${escapeHtml(n.slug)}">${escapeHtml(n.text)}</a>${
              n.children.length > 0 ? list(n.children) : ""
            }</li>\n`,
        )
        .join("")}</ul>\n`;
    return `<nav class="k-toc">\n${list(nestTocEntries(entries))}</nav>\n`;
  }

  /** Footnotes section (numbered by first reference), or "" when there are none. */
  footnoteSection(): string {
    if (this.footnotes.order.length === 0) return "";
    const defs = new Map<string, SyntaxNode>();
    for (const child of children(this.root)) {
      if (child.name !== "FootnoteDefinition") continue;
      const mark = child.getChild("FootnoteMark");
      if (!mark) continue;
      const id = footnoteIdOf(this.slice(mark.from, mark.to));
      if (!defs.has(id)) defs.set(id, child);
    }
    const parsed = this.footnotes.order.map((id, i) => {
      const num = i + 1;
      const def = defs.get(id);
      const info = this.footnotes.definitions.get(id);
      const bodyHtml =
        def && info ? this.inline(def, info.contentFrom, def.to).trim() : "";
      return { num, bodyHtml };
    });
    if (this.hooks.renderFootnoteSection) {
      return this.hooks.renderFootnoteSection(parsed);
    }
    const items = parsed.map(
      ({ num, bodyHtml }) =>
        `<li id="fn-${num}">${bodyHtml} <a class="k-fn-back" href="#fnref-${num}">↩</a></li>\n`,
    );
    return `<section class="k-footnotes">\n<hr>\n<ol>\n${items.join("")}</ol>\n</section>\n`;
  }

  private slice(from: number, to: number): string {
    return this.doc.slice(from, to);
  }

  /** Inline content of `node` between `from` and `to`, skipping markup nodes. */
  inline(node: SyntaxNode, from = node.from, to = node.to): string {
    let out = "";
    let pos = from;
    for (const child of children(node)) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > pos) out += this.text(pos, child.from);
      out += this.inlineNode(child);
      pos = Math.max(pos, child.to);
    }
    if (pos < to) out += this.text(pos, to);
    return out;
  }

  private text(from: number, to: number): string {
    return escapeHtml(this.slice(from, to));
  }

  private inlineNode(node: SyntaxNode): string {
    const name = node.name;
    if (MARK_NODES.has(name)) return "";
    switch (name) {
      case "Emphasis":
        return `<em>${this.inline(node)}</em>`;
      case "StrongEmphasis":
        return `<strong>${this.inline(node)}</strong>`;
      case "Strikethrough":
        return `<del>${this.inline(node)}</del>`;
      case "Subscript":
        return `<sub>${this.inline(node)}</sub>`;
      case "Superscript":
        return `<sup>${this.inline(node)}</sup>`;
      case "InlineCode": {
        const inner = this.inline(node);
        return this.hooks.renderInlineCode
          ? this.hooks.renderInlineCode(inner)
          : `<code>${inner}</code>`;
      }
      case "Escape":
        return escapeHtml(this.slice(node.from + 1, node.to));
      case "Entity": {
        const raw = this.slice(node.from, node.to);
        return /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});$/i.test(raw)
          ? raw
          : escapeHtml(raw);
      }
      case "HardBreak":
        return "<br>";
      case "HTMLTag": {
        const raw = this.slice(node.from, node.to);
        if (/^<br\s*\/?>$/i.test(raw)) return "<br>";
        return this.htmlImage(raw) ?? escapeHtml(raw);
      }
      case "InlineMath": {
        const marks = node.getChildren("InlineMathMark");
        const tex =
          marks.length >= 2
            ? this.slice(marks[0].to, marks[marks.length - 1].from)
            : this.slice(node.from + 1, node.to - 1);
        return this.math(tex, false);
      }
      case "Link":
        return this.link(node);
      case "Image":
        return this.image(node);
      case "FootnoteReference":
        return this.footnoteReference(node);
      case "Autolink": {
        const url = node.getChild("URL");
        const href = url ? this.slice(url.from, url.to) : "";
        const label = escapeHtml(href);
        return isSafeHref(href)
          ? `<a href="${escapeHtml(href)}">${label}</a>`
          : label;
      }
      default:
        // URL (bare GFM autolink) is in MARK_NODES only inside links; a
        // top-level unknown node is rendered as its (escaped) content.
        return this.inline(node);
    }
  }

  private linkParts(node: SyntaxNode): {
    labelFrom: number;
    labelTo: number;
    href: string;
    title: string;
  } {
    const marks = node.getChildren("LinkMark");
    const labelFrom = marks[0]?.to ?? node.from;
    const labelTo = marks[1]?.from ?? node.to;
    const url = node.getChild("URL");
    const title = node.getChild("LinkTitle");
    return {
      labelFrom,
      labelTo,
      href: url ? unwrapDestination(this.slice(url.from, url.to)) : "",
      title: title ? unquoteTitle(this.slice(title.from, title.to)) : "",
    };
  }

  private link(node: SyntaxNode): string {
    const { labelFrom, labelTo, href, title } = this.linkParts(node);
    const label = this.inline(node, labelFrom, labelTo);
    if (!href || !isSafeHref(href)) {
      return this.hooks.renderUnsafeLink
        ? this.hooks.renderUnsafeLink(label)
        : `<span class="k-link">${label}</span>`;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}"${titleAttr}>${label}</a>`;
  }

  private image(node: SyntaxNode): string {
    const { labelFrom, labelTo, href, title } = this.linkParts(node);
    const alt = this.slice(labelFrom, labelTo)
      .replace(/[*_`~]/g, "")
      .trim();
    return this.imageElement(href, alt, title, "");
  }

  private imageElement(
    href: string,
    alt: string,
    title: string,
    style: string,
  ): string {
    if (this.hooks.renderImage) {
      return this.hooks.renderImage(href, alt, title, style);
    }
    const resolved = resolveImageSrc(
      href,
      this.docPath,
      fileUrlFromPath,
      this.imageRoot,
    );
    const src =
      resolved.kind === "remote" ||
      resolved.kind === "data" ||
      resolved.kind === "local"
        ? resolved.url
        : null;
    if (!src) {
      return `<span class="k-image-missing">[${escapeHtml(alt || href)}]</span>`;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const styleAttr = style ? ` style="${escapeHtml(style)}"` : "";
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr}${styleAttr}>`;
  }

  /** IM-03: a single `<img>` tag, rebuilt from its allow-listed attributes only. */
  private htmlImage(raw: string): string | null {
    const tag = parseImgTag(raw);
    if (!tag) return null;
    return this.imageElement(
      tag.src,
      tag.alt,
      tag.title ?? "",
      imageSizeCss(tag.size),
    );
  }

  /** An HTML block whose every non-blank line is one `<img>` tag. */
  private htmlImageBlock(from: number, to: number): string | null {
    const lines = this.slice(from, to)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const images: string[] = [];
    for (const line of lines) {
      const img = this.htmlImage(line);
      if (img === null) return null;
      images.push(img);
    }
    return `<p>${images.join("\n")}</p>\n`;
  }

  block(node: SyntaxNode): string {
    const name = node.name;
    const level = HEADING_LEVELS[name];
    if (level !== undefined) return this.heading(node, level);
    switch (name) {
      case "Document":
        return children(node)
          .map((c) => this.block(c))
          .join("");
      case "Paragraph":
        if (
          node.parent?.name === "Document" &&
          isTocText(this.slice(node.from, node.to))
        ) {
          return this.toc();
        }
        return `<p>${this.inline(node).trim()}</p>\n`;
      case "FrontMatter":
      case "FootnoteDefinition":
        return "";
      case "Blockquote": {
        const inner = this.blocks(node);
        return this.hooks.renderBlockquote
          ? this.hooks.renderBlockquote(inner)
          : `<blockquote>\n${inner}</blockquote>\n`;
      }
      case "BulletList":
        return `<ul>\n${this.blocks(node)}</ul>\n`;
      case "OrderedList": {
        const firstMark = node.firstChild?.getChild("ListMark");
        const start = firstMark
          ? Number.parseInt(this.slice(firstMark.from, firstMark.to), 10)
          : 1;
        const startAttr =
          Number.isFinite(start) && start !== 1 ? ` start="${start}"` : "";
        return `<ol${startAttr}>\n${this.blocks(node)}</ol>\n`;
      }
      case "ListItem":
        return this.listItem(node);
      case "Task":
        return this.task(node);
      case "FencedCode":
        return this.fencedCode(node);
      case "CodeBlock":
        return this.indentedCode(node);
      case "HorizontalRule":
        return this.hooks.renderHorizontalRule
          ? this.hooks.renderHorizontalRule()
          : "<hr>\n";
      case "Table":
        return this.table(node);
      case "BlockMath": {
        const marks = node.getChildren("BlockMathMark");
        const tex =
          marks.length >= 2
            ? this.slice(marks[0].to, marks[marks.length - 1].from)
            : this.slice(node.from, node.to).replace(/^\s*\$\$|\$\$\s*$/g, "");
        return `${this.math(tex, true)}\n`;
      }
      case "HTMLBlock": {
        const imgBlock = this.htmlImageBlock(node.from, node.to);
        if (imgBlock !== null) return imgBlock;
        const escaped = this.text(node.from, node.to);
        return this.hooks.renderRawHtmlBlock
          ? this.hooks.renderRawHtmlBlock(escaped)
          : `<pre class="k-raw-html">${escaped}</pre>\n`;
      }
      case "LinkReference":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        return "";
      default:
        if (MARK_NODES.has(name)) return "";
        return `<p>${this.inline(node).trim()}</p>\n`;
    }
  }

  private blocks(node: SyntaxNode): string {
    return children(node)
      .filter((c) => !MARK_NODES.has(c.name))
      .map((c) => this.block(c))
      .join("");
  }

  private heading(node: SyntaxNode, level: number): string {
    const entry = this.headings[this.headingIndex++];
    let to = node.to;
    if (node.name.startsWith("Setext")) {
      const marks = node.getChildren("HeaderMark");
      const underline = marks[marks.length - 1];
      if (underline) to = underline.from;
    }
    const inner = this.inline(node, node.from, to).trim();
    if (this.hooks.renderHeading) {
      return this.hooks.renderHeading(level, entry?.id ?? null, inner);
    }
    const idAttr = entry ? ` id="${escapeHtml(entry.id)}"` : "";
    return `<h${level}${idAttr}>${inner}</h${level}>\n`;
  }

  private listItem(node: SyntaxNode): string {
    const task = node.getChild("Task");
    if (task && this.hooks.renderTaskItem) {
      const marker = task.getChild("TaskMarker");
      const checked = marker
        ? /x/i.test(this.slice(marker.from, marker.to))
        : false;
      const bodyParts = children(node)
        .filter((c) => !MARK_NODES.has(c.name))
        .map((c) =>
          c.name === "Task" ? this.inline(c).trim() : this.block(c),
        );
      return this.hooks.renderTaskItem(checked, bodyParts.join(""));
    }
    const body = this.blocks(node);
    if (task) return `<li class="k-task">${body}</li>\n`;
    return `<li>${body}</li>\n`;
  }

  private task(node: SyntaxNode): string {
    const marker = node.getChild("TaskMarker");
    const checked = marker
      ? /x/i.test(this.slice(marker.from, marker.to))
      : false;
    const box = `<span class="k-task-box" data-checked="${checked}">${checked ? "✓" : ""}</span>`;
    return `${box}<span class="k-task-text">${this.inline(node).trim()}</span>`;
  }

  /** Strip up to `indent` leading spaces from every line (list-nested code). */
  private dedent(code: string, indent: number): string {
    if (indent <= 0) return code;
    const re = new RegExp(`^ {0,${indent}}`);
    return code
      .split("\n")
      .map((line) => line.replace(re, ""))
      .join("\n");
  }

  private columnOf(pos: number): number {
    const lineStart = this.doc.lastIndexOf("\n", pos - 1) + 1;
    return pos - lineStart;
  }

  /** Info string, body (dedented) and whether the fence is closed. */
  fenceParts(node: SyntaxNode): {
    infoString: string;
    code: string;
    closed: boolean;
  } {
    const info = node.getChild("CodeInfo");
    const infoString = info ? this.slice(info.from, info.to).trim() : "";
    const marks = node.getChildren("CodeMark");
    const open = marks[0];
    const close = marks.length >= 2 ? marks[marks.length - 1] : null;
    const openLineEnd = this.doc.indexOf("\n", open ? open.to : node.from);
    const bodyFrom =
      openLineEnd < 0 || openLineEnd >= node.to ? node.to : openLineEnd + 1;
    let bodyTo = node.to;
    if (close && close.from >= bodyFrom) {
      const closeLineStart = this.doc.lastIndexOf("\n", close.from - 1) + 1;
      bodyTo = Math.max(bodyFrom, closeLineStart - 1);
    }
    const code = this.dedent(
      this.slice(bodyFrom, bodyTo),
      this.columnOf(node.from),
    );
    return {
      infoString,
      code,
      closed: close !== null && close.from >= bodyFrom,
    };
  }

  private fencedCode(node: SyntaxNode): string {
    const { infoString, code } = this.fenceParts(node);
    const lang = infoString.split(/\s+/)[0] ?? "";
    const highlighted = this.highlight(code, infoString);
    const pre = this.hooks.renderCodeBlock
      ? this.hooks.renderCodeBlock(highlighted, lang)
      : `<pre class="k-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${highlighted}</code></pre>\n`;
    const diagram = this.diagrams.get(node.from);
    if (!diagram) return pre;
    const index = this.diagramIndex++;
    if (diagram.svg) {
      if (this.hooks.renderDiagram) {
        return this.hooks.renderDiagram(diagram.svg, lang.toLowerCase(), index);
      }
      return `<figure class="k-diagram" data-kind="${escapeHtml(lang.toLowerCase())}">${diagram.svg}</figure>\n`;
    }
    const title = diagramErrorTitle(diagram);
    const detail = (diagram.error ?? "").split("\n")[0].slice(0, 200);
    const message = detail
      ? t("dialog.errorWithDetail", { prefix: title, detail })
      : title;
    const errHtml = this.hooks.renderDiagramError
      ? this.hooks.renderDiagramError(message)
      : `<p class="k-diagram-error">${escapeHtml(message)}</p>\n`;
    return `${pre}${errHtml}`;
  }

  private indentedCode(node: SyntaxNode): string {
    const code = this.slice(node.from, node.to)
      .split("\n")
      .map((line, i) => (i === 0 ? line : line.replace(/^( {4}|\t)/, "")))
      .join("\n");
    const escaped = escapeHtml(code);
    return this.hooks.renderCodeBlock
      ? this.hooks.renderCodeBlock(escaped, "")
      : `<pre class="k-code"><code>${escaped}</code></pre>\n`;
  }

  private table(node: SyntaxNode): string {
    const rows = children(node);
    const delimiterRow = rows.find(
      (c) => c.name === "TableDelimiter" && /-/.test(this.slice(c.from, c.to)),
    );
    const aligns = delimiterRow
      ? this.splitRowText(this.slice(delimiterRow.from, delimiterRow.to)).map(
          (cell) => {
            const t = cell.trim();
            const left = t.startsWith(":");
            const right = t.endsWith(":");
            if (left && right) return "center";
            if (right) return "right";
            if (left) return "left";
            return "";
          },
        )
      : [];
    const header = rows.find((c) => c.name === "TableHeader");
    const body = rows.filter((c) => c.name === "TableRow");
    const columnCount = Math.max(
      aligns.length,
      header ? this.rowCells(header).length : 0,
      1,
    );
    const padCells = (cells: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < columnCount; i++) out.push(cells[i] ?? "");
      return out;
    };
    const normAligns = Array.from(
      { length: columnCount },
      (_, i) => aligns[i] ?? "",
    );

    if (this.hooks.renderTable) {
      return this.hooks.renderTable(
        header ? padCells(this.rowCells(header)) : null,
        body.map((r) => padCells(this.rowCells(r))),
        normAligns,
      );
    }

    const renderRow = (row: SyntaxNode, tag: "th" | "td") => {
      const cells = this.rowCells(row);
      let out = "<tr>";
      for (let i = 0; i < columnCount; i++) {
        const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
        out += `<${tag}${align}>${cells[i] ?? ""}</${tag}>`;
      }
      return `${out}</tr>\n`;
    };

    let out = '<table class="k-table">\n';
    if (header) out += `<thead>\n${renderRow(header, "th")}</thead>\n`;
    if (body.length > 0) {
      out += `<tbody>\n${body.map((r) => renderRow(r, "td")).join("")}</tbody>\n`;
    }
    return `${out}</table>\n`;
  }

  private splitRowText(text: string): string[] {
    let t = text.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/);
  }

  /** Cells of a table row as rendered HTML, split at the row's `|` delimiters. */
  private rowCells(row: SyntaxNode): string[] {
    const kids = children(row);
    const pipes = kids.filter((c) => c.name === "TableDelimiter");
    const bounds: number[] = [];
    const lineText = this.slice(row.from, row.to);
    const leading = lineText.trimStart().startsWith("|");
    if (!leading) bounds.push(row.from);
    for (const p of pipes) bounds.push(p.from, p.to);
    const trailing = lineText.trimEnd().endsWith("|") && pipes.length > 0;
    if (!trailing) bounds.push(row.to);
    // bounds: [segStart?, pipeFrom, pipeTo, pipeFrom, pipeTo, ..., segEnd?]
    const segments: Array<[number, number]> = [];
    let cursor: number | null = leading ? null : row.from;
    let i = leading ? 0 : 1;
    for (; i < bounds.length; i += 2) {
      const pipeFrom = bounds[i];
      const pipeTo = bounds[i + 1];
      if (cursor !== null) segments.push([cursor, pipeFrom]);
      if (pipeTo === undefined) break;
      cursor = pipeTo;
    }
    return segments.map(([from, to]) => {
      const cell = kids.find(
        (c) => c.name === "TableCell" && c.from >= from && c.to <= to,
      );
      return cell ? this.inline(cell).trim() : "";
    });
  }
}

export function createExportParseState(content: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      createMarkdownSupport({
        pasteURLAsLink: false,
        extensions: [
          mathMarkdownExtension,
          cjkEmphasisExtension,
          frontMatterExtension,
          footnoteExtension,
        ],
      }),
    ],
  });
}

/** Collect every image href referenced in Markdown or allow-listed `<img>` tags. */
export function collectExportImageHrefs(
  tree: ReturnType<typeof syntaxTree>,
  doc: string,
): string[] {
  const hrefs: string[] = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name === "Image") {
        const url = ref.node.getChild("URL");
        if (url) hrefs.push(unwrapDestination(doc.slice(url.from, url.to)));
        return false;
      }
      if (ref.name === "HTMLTag") {
        const tag = parseImgTag(doc.slice(ref.from, ref.to));
        if (tag?.src) hrefs.push(tag.src);
        return false;
      }
      if (ref.name === "HTMLBlock") {
        const lines = doc
          .slice(ref.from, ref.to)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const parsed = lines.map((line) => parseImgTag(line));
        if (parsed.length > 0 && parsed.every((p) => p !== null)) {
          for (const p of parsed) {
            if (p?.src) hrefs.push(p.src);
          }
        }
        return false;
      }
      return undefined;
    },
  });
  return hrefs;
}

export interface RenderMarkdownBodyOptions {
  docPath: string | null;
  mathAutoNumber?: boolean;
  imageRootDir?: string | null;
  frontMatterImageRoot?: string | null;
  formatCodeToken?: CodeTokenFormatter;
  prepareMath?: (
    formulas: ReadonlyArray<{ tex: string; display: boolean }>,
    autoNumber: boolean,
  ) => Promise<MathRenderer>;
  hooks?: RenderFormatHooks;
  /** Optional hook invoked after diagrams are rendered (e.g. SVG→PNG rasterization). */
  onDiagramsRendered?: (
    diagrams: ReadonlyArray<{ kind: string; result: DiagramRenderResult }>,
  ) => Promise<void>;
}

/**
 * Shared Markdown → HTML body pipeline used by both PDF export (`buildExportHtml`)
 * and Copy as Rich Text (`buildRichTextHtml`).
 */
export async function renderMarkdownBody(
  content: string,
  options: RenderMarkdownBodyOptions,
): Promise<{ body: string; headings: ExportHeading[] }> {
  const state = createExportParseState(content);
  const tree =
    ensureSyntaxTree(state, state.doc.length, 10_000) ?? syntaxTree(state);
  const doc = state.doc.toString();
  const headings = collectDocumentHeadings(state).map((h) => ({
    level: h.level,
    text: h.text,
    id: h.slug,
  }));

  const codeInfos: string[] = [];
  const mathFormulas: Array<{ tex: string; display: boolean }> = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name === "FencedCode") {
        const info = ref.node.getChild("CodeInfo");
        if (info) codeInfos.push(doc.slice(info.from, info.to).trim());
        return false;
      }
      if (ref.name === "InlineMath") {
        const marks = ref.node.getChildren("InlineMathMark");
        const tex =
          marks.length >= 2
            ? doc.slice(marks[0].to, marks[marks.length - 1].from)
            : doc.slice(ref.from + 1, ref.to - 1);
        mathFormulas.push({ tex, display: false });
        return false;
      }
      if (ref.name === "BlockMath") {
        const marks = ref.node.getChildren("BlockMathMark");
        const tex =
          marks.length >= 2
            ? doc.slice(marks[0].to, marks[marks.length - 1].from)
            : doc.slice(ref.from, ref.to).replace(/^\s*\$\$|\$\$\s*$/g, "");
        mathFormulas.push({ tex, display: true });
        return false;
      }
      return undefined;
    },
  });

  const [highlight, math] = await Promise.all([
    prepareCodeHighlighter(codeInfos, options.formatCodeToken),
    options.prepareMath
      ? options.prepareMath(mathFormulas, Boolean(options.mathAutoNumber))
      : prepareMathRenderer(
          mathFormulas.length > 0,
          Boolean(options.mathAutoNumber),
        ),
  ]);
  const footnotes = buildFootnoteIndex(tree, (from, to) => doc.slice(from, to));
  const imageRoot = resolveImageRoot(
    options.frontMatterImageRoot !== undefined
      ? options.frontMatterImageRoot
      : findTyporaRootUrlInText(doc),
    options.docPath,
    options.imageRootDir ?? null,
  );
  // Diagrams: collect closed mermaid / flow / sequence fences, render them in order.
  const probe = new Renderer(
    doc,
    headings,
    options.docPath,
    highlight,
    math,
    footnotes,
    tree.topNode,
  );
  const fenceNodes: Array<{ from: number; fence: DiagramFence }> = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== "FencedCode") return undefined;
      const { infoString, code, closed } = probe.fenceParts(ref.node);
      const kind = resolveDiagramKind(infoString);
      if (kind && closed)
        fenceNodes.push({ from: ref.from, fence: { kind, source: code } });
      return false;
    },
  });
  const rendered = await renderExportDiagrams(fenceNodes.map((f) => f.fence));
  if (options.onDiagramsRendered && rendered.length > 0) {
    await options.onDiagramsRendered(
      fenceNodes.map((f, i) => ({ kind: f.fence.kind, result: rendered[i] })),
    );
  }
  const diagrams = new Map(
    fenceNodes.map((f, i) => [f.from, rendered[i]] as const),
  );

  const renderer = new Renderer(
    doc,
    headings,
    options.docPath,
    highlight,
    math,
    footnotes,
    tree.topNode,
    imageRoot,
    diagrams,
    options.hooks,
  );
  const body = renderer.block(tree.topNode) + renderer.footnoteSection();
  return { body, headings };
}

/** Headings (level, text, slug id) of a Markdown document, in document order. */
export function collectExportHeadings(content: string): ExportHeading[] {
  return collectDocumentHeadings(createExportParseState(content)).map((h) => ({
    level: h.level,
    text: h.text,
    id: h.slug,
  }));
}

export async function buildExportHtml(
  content: string,
  options: ExportHtmlOptions,
): Promise<ExportHtmlResult> {
  const { body, headings } = await renderMarkdownBody(content, {
    docPath: options.docPath,
    mathAutoNumber: options.mathAutoNumber,
    imageRootDir: options.imageRootDir,
  });

  const csp =
    "default-src 'none'; img-src file: data: https: http:; style-src 'unsafe-inline'; font-src file: data:";
  const html = [
    "<!DOCTYPE html>",
    '<html lang="zh-Hant">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>\n${printCss}\n</style>`,
    "</head>",
    "<body>",
    `<article class="k-export">\n${body}</article>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { html, headings };
}
