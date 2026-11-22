/**
 * NV-03 word count. Counts what a reader sees: the Markdown syntax tree is
 * used to drop front matter and markup (heading / emphasis / code marks,
 * quote and list markers, table pipes, link URLs, image destinations, HTML
 * tags) before counting.
 *
 * - words: every CJK character (Han, Kana, Hangul) is one word; every run of
 *   other letters / digits (with inner `'` `’` `-`) is one word.
 * - chars: user-perceived characters (emoji = 1), line breaks excluded;
 *   charsNoSpaces additionally excludes all whitespace.
 * - lines: lines of the counted range (empty = 0, a trailing newline adds none).
 * - readingMinutes: CJK at 400/min + other words at 200/min, rounded up.
 * Math source ($…$, $$…$$) is not counted: readers see a formula, not words.
 */
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";

export interface TextStats {
  words: number;
  chars: number;
  charsNoSpaces: number;
  lines: number;
  readingMinutes: number;
}

export const EMPTY_STATS: TextStats = {
  words: 0,
  chars: 0,
  charsNoSpaces: 0,
  lines: 0,
  readingMinutes: 0,
};

const CJK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;
/** Text where code points ≠ graphemes (ZWJ emoji, variation selectors, flags, marks…). */
const COMPLEX_GRAPHEME_RE =
  /[‍︎️\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\p{M}]/u;

let segmenter: { segment: (s: string) => Iterable<unknown> } | null | undefined;

function graphemeCount(text: string): number {
  if (!COMPLEX_GRAPHEME_RE.test(text)) {
    let n = 0;
    for (const _ of text) n++;
    return n;
  }
  if (segmenter === undefined) {
    const Seg = (
      Intl as unknown as {
        Segmenter?: new (l?: string, o?: object) => typeof segmenter;
      }
    ).Segmenter;
    segmenter = Seg ? new Seg(undefined, { granularity: "grapheme" }) : null;
  }
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Number of lines in `text` (empty = 0; a trailing line break adds none). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.endsWith("\n")) n--;
  return n;
}

/** Count already-visible text (no Markdown stripping). `lines` comes from the raw text. */
export function countPlain(visible: string, lines: number): TextStats {
  const cjk = visible.match(CJK_RE)?.length ?? 0;
  const rest = cjk > 0 ? visible.replace(CJK_RE, " ") : visible;
  const others = rest.match(WORD_RE)?.length ?? 0;
  const words = cjk + others;
  const noBreaks = visible.replace(/[\r\n\u2028\u2029]/g, "");
  const chars = graphemeCount(noBreaks);
  const charsNoSpaces = graphemeCount(noBreaks.replace(/\s/gu, ""));
  const readingMinutes =
    words > 0 ? Math.max(1, Math.ceil(cjk / 400 + others / 200)) : 0;
  return { words, chars, charsNoSpaces, lines, readingMinutes };
}

/** Markup removed outright (contributes nothing). */
const DROP_NODES = new Set([
  "FrontMatter",
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "CodeInfo",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "LinkMark",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "StrikethroughMark",
  "SubscriptMark",
  "SuperscriptMark",
  "InlineMath",
  "BlockMath",
  "FootnoteMark",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
  "LinkReference",
]);

/** Markup replaced by a line break (a word boundary that is not a character). */
const BREAK_NODES = new Set(["TableDelimiter", "HorizontalRule", "HTMLTag"]);

/** Drop ranges / break ranges for `[from, to)` taken from the syntax tree. */
function markupRanges(
  tree: Tree,
  from: number,
  to: number,
  slice: (a: number, b: number) => string,
): Array<{ from: number; to: number; br: boolean }> {
  const out: Array<{ from: number; to: number; br: boolean }> = [];
  tree.iterate({
    from,
    to,
    enter: (ref) => {
      const name = ref.name;
      if (DROP_NODES.has(name)) {
        // A URL that is the whole content of an autolink / bare GFM link is visible text.
        if (
          name === "URL" &&
          ref.node.parent?.name !== "Link" &&
          ref.node.parent?.name !== "Image"
        ) {
          return false;
        }
        out.push({ from: ref.from, to: ref.to, br: false });
        return false;
      }
      if (BREAK_NODES.has(name)) {
        out.push({ from: ref.from, to: ref.to, br: true });
        return false;
      }
      if (name === "Escape") {
        out.push({ from: ref.from, to: ref.from + 1, br: false });
        return false;
      }
      if (name === "HTMLBlock") {
        // Keep the text between tags.
        const text = slice(ref.from, ref.to);
        for (const m of text.matchAll(/<[^>]*>/g)) {
          out.push({
            from: ref.from + m.index,
            to: ref.from + m.index + m[0].length,
            br: true,
          });
        }
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/** Visible text of `[from, to)` given a (possibly partial) syntax tree. */
export function visibleText(
  tree: Tree,
  from: number,
  to: number,
  slice: (a: number, b: number) => string,
): string {
  if (from >= to) return "";
  const parsedTo = Math.min(to, tree.length);
  let out = "";
  let pos = from;
  if (parsedTo > from) {
    const ranges = markupRanges(tree, from, parsedTo, slice).sort(
      (a, b) => a.from - b.from,
    );
    for (const r of ranges) {
      const rFrom = Math.max(r.from, from);
      const rTo = Math.min(r.to, to);
      if (rTo <= pos) continue;
      if (rFrom > pos) out += slice(pos, rFrom);
      if (r.br) out += "\n";
      pos = Math.max(pos, rTo);
    }
  }
  if (pos < to) out += slice(pos, to);
  return out;
}

const countParser = (markdownLanguage.parser as MarkdownParser).configure([
  mathMarkdownExtension,
  cjkEmphasisExtension,
  frontMatterExtension,
  footnoteExtension,
]);

/** Statistics for a Markdown string (parsed with the editor's Markdown dialect). */
export function countText(text: string): TextStats {
  if (!text) return { ...EMPTY_STATS };
  const tree = countParser.parse(text);
  const visible = visibleText(tree, 0, text.length, (a, b) => text.slice(a, b));
  return countPlain(visible, countLines(text));
}

/** Statistics for `[from, to)` of an editor state, using its syntax tree. */
export function countRange(
  state: EditorState,
  from: number,
  to: number,
): TextStats {
  if (from >= to) return { ...EMPTY_STATS };
  const slice = (a: number, b: number) => state.sliceDoc(a, b);
  const visible = visibleText(syntaxTree(state), from, to, slice);
  return countPlain(visible, countLines(slice(from, to)));
}

/** Statistics for the whole document. */
export function countDocument(state: EditorState): TextStats {
  return countRange(state, 0, state.doc.length);
}

/** Sum of all non-empty selection ranges, or null when nothing is selected. */
export function countSelection(state: EditorState): TextStats | null {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (ranges.length === 0) return null;
  const tree = syntaxTree(state);
  const slice = (a: number, b: number) => state.sliceDoc(a, b);
  let lines = 0;
  const parts: string[] = [];
  for (const r of ranges) {
    parts.push(visibleText(tree, r.from, r.to, slice));
    lines += countLines(slice(r.from, r.to));
  }
  return countPlain(parts.join("\n"), lines);
}

/** Total characters in the selection (cheap; decides immediate vs debounced counting). */
export function selectionSize(state: EditorState): number {
  return state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
}
