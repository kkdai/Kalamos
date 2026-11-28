import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { createMarkdownSupport } from "./markdown-lang";
import {
  ensureMathJaxLoaded,
  isMathEngineLoaded,
  mathExtension,
  mathMarkdownExtension,
} from "./math";
import { ensureFullSyntaxTree } from "./test-utils";

function parseNodeNames(doc: string): string[] {
  const state = ensureFullSyntaxTree(
    EditorState.create({
      doc,
      extensions: [
        createMarkdownSupport({
          extensions: [
            mathMarkdownExtension,
            cjkEmphasisExtension,
            frontMatterExtension,
            footnoteExtension,
          ],
        }),
      ],
    }),
  );
  const names: string[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      names.push(ref.name);
    },
  });
  return names;
}

describe("createMarkdownSupport (#146)", () => {
  it("parses GFM, math, front matter, footnotes, and raw HTML nodes without lang-html", () => {
    const doc = [
      "---",
      "title: Demo",
      "---",
      "",
      "# Heading",
      "",
      "~~strike~~ $x+1$ H~2~O 2^3^ [^1]",
      "",
      '<img src="pic.png" width="50%">',
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
      "",
      "[^1]: note",
    ].join("\n");

    const names = parseNodeNames(doc);
    expect(names).toContain("FrontMatter");
    expect(names).toContain("ATXHeading1");
    expect(names).toContain("Strikethrough");
    expect(names).toContain("InlineMath");
    expect(names).toContain("BlockMath");
    expect(names).toContain("Subscript");
    expect(names).toContain("Superscript");
    expect(names).toContain("FootnoteReference");
    expect(names).toContain("FootnoteDefinition");
    expect(names).toContain("HTMLBlock");
    expect(names).toContain("Table");
  });

  it("shows pending state for math before MathJax loads and transitions to rendered", async () => {
    const doc = "Text $a+b$ end\n\n$$\nx^2\n$$\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = ensureFullSyntaxTree(
      EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          createMarkdownSupport({ extensions: [mathMarkdownExtension] }),
          mathExtension,
        ],
      }),
    );
    const view = new EditorView({ state, parent });
    try {
      const inlineEl = view.dom.querySelector<HTMLElement>(
        '[data-testid="math-inline"]',
      );
      const blockEl = view.dom.querySelector<HTMLElement>(
        '[data-testid="math-block"]',
      );
      expect(inlineEl).not.toBeNull();
      expect(blockEl).not.toBeNull();

      if (!isMathEngineLoaded()) {
        expect(inlineEl!.dataset.state).toBe("pending");
        expect(inlineEl!.classList.contains("k-math-pending")).toBe(true);
        expect(blockEl!.dataset.state).toBe("pending");
        expect(blockEl!.classList.contains("k-math-pending")).toBe(true);
      }

      await ensureMathJaxLoaded(view);

      const renderedInline = view.dom.querySelector<HTMLElement>(
        '[data-testid="math-inline"]',
      );
      const renderedBlock = view.dom.querySelector<HTMLElement>(
        '[data-testid="math-block"]',
      );
      expect(renderedInline?.dataset.state).toBe("rendered");
      expect(renderedInline?.querySelector("svg")).not.toBeNull();
      expect(renderedBlock?.dataset.state).toBe("rendered");
      expect(renderedBlock?.querySelector("svg")).not.toBeNull();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
