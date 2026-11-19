/**
 * ED-06: YAML front matter — a `---` line at the very start of the document,
 * up to the next `---` or `...` line. Parsed as a `FrontMatter` node (with
 * `FrontMatterMark` children for the two fences) so it is never read as a
 * horizontal rule or a Setext heading, and so the outline / export can skip it.
 */
import type { Input } from "@lezer/common";
import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown";

const OPEN_RE = /^---[ \t]*$/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/** Text of the document after `pos` (the parser's input; internal to lezer). */
function readAhead(cx: BlockContext, from: number): string | null {
  const input = (cx as unknown as { input?: Input }).input;
  if (!input || typeof input.read !== "function") return null;
  return input.read(from, input.length);
}

/** Does a closing fence line follow the opening fence that ends at `openEnd`? */
export function hasClosingFence(rest: string): boolean {
  // `rest` starts right after the opening line's newline.
  for (const line of rest.split("\n")) {
    if (CLOSE_RE.test(line.replace(/\r$/, ""))) return true;
  }
  return false;
}

export const frontMatterExtension: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    { name: "FrontMatterMark" },
  ],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line): boolean {
        if (cx.lineStart !== 0 || cx.depth > 1) return false;
        if (!OPEN_RE.test(line.text)) return false;
        const rest = readAhead(cx, line.text.length + 1);
        if (rest === null || !hasClosingFence(rest)) return false;

        const children = [cx.elt("FrontMatterMark", 0, 3)];
        while (cx.nextLine()) {
          if (CLOSE_RE.test(line.text)) {
            const closeFrom = cx.lineStart;
            const closeTo = closeFrom + line.text.length;
            children.push(cx.elt("FrontMatterMark", closeFrom, closeFrom + 3));
            cx.nextLine();
            cx.addElement(cx.elt("FrontMatter", 0, closeTo, children));
            return true;
          }
        }
        // Unreachable when hasClosingFence() was right; keep the doc parseable.
        cx.addElement(cx.elt("FrontMatter", 0, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};
