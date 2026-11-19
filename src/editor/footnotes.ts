/**
 * ED-06: footnotes. GFM in @lezer/markdown has no footnotes, so this adds
 * - `FootnoteReference` inline nodes for `[^id]`
 * - `FootnoteDefinition` blocks for `[^id]: text` (continuation lines indented
 *   by 4 spaces / a tab belong to it), with a `FootnoteMark` child for the
 *   `[^id]:` prefix and the text parsed as inline content.
 * Numbering: footnotes are numbered by the order of their first reference;
 * a reference without a definition is not a footnote (it stays literal).
 */
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import type {
  BlockContext,
  InlineContext,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

const DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]?/;
const CONTINUATION_RE = /^(?: {4}|\t)\S?/;

export const footnoteExtension: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteReference" },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteMark" },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "LinkReference",
      parse(cx: BlockContext, line: Line): boolean {
        if (line.indent > 3) return false;
        const text = line.text.slice(line.pos);
        const m = DEF_RE.exec(text);
        if (!m) return false;
        const from = cx.lineStart + line.pos;
        const markTo = from + m[0].replace(/[ \t]$/, "").length;
        const contentFrom = from + m[0].length;
        let content = line.text.slice(line.pos + m[0].length);
        let to = cx.lineStart + line.text.length;
        while (true) {
          const next = cx.peekLine();
          if (!next.trim() || !CONTINUATION_RE.test(next)) break;
          cx.nextLine();
          content += `\n${line.text}`;
          to = cx.lineStart + line.text.length;
        }
        cx.nextLine();
        const children = [
          cx.elt("FootnoteMark", from, markTo),
          ...cx.parser.parseInline(content, contentFrom),
        ];
        cx.addElement(cx.elt("FootnoteDefinition", from, to, children));
        return true;
      },
    },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1;
        let i = pos + 2;
        for (; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 93 /* ] */) break;
          if (ch === 91 || ch === 32 || ch === 9 || ch === 10 || ch === 13) return -1;
        }
        if (i >= cx.end || i === pos + 2) return -1;
        return cx.addElement(cx.elt("FootnoteReference", pos, i + 1));
      },
    },
  ],
};

/** `[^id]` / `[^id]:` → `id`. */
export function footnoteIdOf(text: string): string {
  return text.replace(/^\[\^/, "").replace(/\]:?\s*$/, "");
}

export interface FootnoteDefinitionInfo {
  id: string;
  from: number;
  to: number;
  /** Where the definition text starts (after `[^id]: `). */
  contentFrom: number;
}

export interface FootnoteIndex {
  /** id → number (1-based), by first reference; only defined footnotes. */
  numbers: Map<string, number>;
  /** First definition of each id. */
  definitions: Map<string, FootnoteDefinitionInfo>;
  /** Footnote ids in number order. */
  order: string[];
}

function definitionInfo(
  node: SyntaxNode,
  slice: (from: number, to: number) => string,
): FootnoteDefinitionInfo | null {
  const mark = node.getChild("FootnoteMark");
  if (!mark) return null;
  let contentFrom = mark.to;
  while (contentFrom < node.to && /[ \t]/.test(slice(contentFrom, contentFrom + 1))) {
    contentFrom++;
  }
  return {
    id: footnoteIdOf(slice(mark.from, mark.to)),
    from: node.from,
    to: node.to,
    contentFrom,
  };
}

/** Collect footnote numbering and definitions from a parsed tree. */
export function buildFootnoteIndex(
  tree: Tree,
  slice: (from: number, to: number) => string,
): FootnoteIndex {
  const definitions = new Map<string, FootnoteDefinitionInfo>();
  const refs: string[] = [];
  tree.iterate({
    enter: (ref) => {
      switch (ref.name) {
        case "FencedCode":
        case "CodeBlock":
        case "HTMLBlock":
        case "CommentBlock":
        case "FrontMatter":
          return false;
        case "FootnoteDefinition": {
          const info = definitionInfo(ref.node, slice);
          if (info && !definitions.has(info.id)) definitions.set(info.id, info);
          return undefined;
        }
        case "FootnoteReference":
          refs.push(footnoteIdOf(slice(ref.from, ref.to)));
          return false;
        default:
          return undefined;
      }
    },
  });
  const numbers = new Map<string, number>();
  const order: string[] = [];
  for (const id of refs) {
    if (!definitions.has(id) || numbers.has(id)) continue;
    order.push(id);
    numbers.set(id, order.length);
  }
  return { numbers, definitions, order };
}

export function footnoteIndexOfState(state: EditorState, tree: Tree): FootnoteIndex {
  return buildFootnoteIndex(tree, (from, to) => state.sliceDoc(from, to));
}

/** Plain text of a definition (inline markup kept as typed, whitespace collapsed). */
export function footnoteDefinitionText(
  info: FootnoteDefinitionInfo,
  slice: (from: number, to: number) => string,
): string {
  return slice(info.contentFrom, info.to).replace(/\s+/g, " ").trim();
}
