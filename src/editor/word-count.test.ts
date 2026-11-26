import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";
import { ensureFullSyntaxTree } from "./test-utils";
import {
  countDocument,
  countLines,
  countSelection,
  countText,
} from "./word-count";
import {
  counterLabel,
  createWordCounter,
  DOC_COUNT_DEBOUNCE_MS,
} from "./word-count-view";

function stateOf(doc: string, selection?: EditorSelection): EditorState {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        extensions: [
          mathMarkdownExtension,
          cjkEmphasisExtension,
          frontMatterExtension,
          footnoteExtension,
        ],
      }),
    ],
  });
  return ensureFullSyntaxTree(state);
}

describe("NV-03 countText", () => {
  it("counts each CJK character as a word", () => {
    expect(countText("中文字數統計")).toEqual({
      words: 6,
      chars: 6,
      charsNoSpaces: 6,
      lines: 1,
      readingMinutes: 1,
    });
    expect(countText("ひらがなカタカナ한국어").words).toBe(11);
  });

  it("counts English words (apostrophes / hyphens inside words) and numbers", () => {
    const s = countText("It's a well-known fact, 42 times. 3.14");
    expect(s.words).toBe(8); // It's, a, well-known, fact, 42, times, 3, 14 ("3.14" is two runs)
    expect(s.chars).toBe(38);
    expect(s.charsNoSpaces).toBe(32);
  });

  it("handles mixed CJK / English text", () => {
    const s = countText("中文English混排 test");
    expect(s.words).toBe(6); // 中 文 English 混 排 test
    expect(s.chars).toBe(16);
    expect(s.charsNoSpaces).toBe(15);
  });

  it("counts an emoji (including ZWJ sequences and flags) as one character", () => {
    const s = countText("hi 👋🏽 👨‍👩‍👧 🇹🇼");
    expect(s.chars).toBe(8);
    expect(s.charsNoSpaces).toBe(5);
    expect(s.words).toBe(1);
  });

  it("strips Markdown markup readers do not see", () => {
    const md = [
      "# Title",
      "",
      "Some **bold** and *em* and `code` text.",
      "",
      "> quoted line",
      "",
      "- item one",
      "- [x] done",
      "",
      '[link text](https://example.com/very/long/url "title") ![alt](img/a.png)',
      "",
      "| a | b |",
      "|---|---|",
      "| c | d |",
      "",
      "<span>html</span> 中文",
      "",
      "---",
    ].join("\n");
    const s = countText(md);
    // Title | Some bold and em and code text | quoted line | item one | done |
    // link text | alt | a b c d | html | 中 文
    expect(s.words).toBe(23);
    expect(s.lines).toBe(18);
    expect(countText("**粗體**").chars).toBe(2);
    expect(countText("[a](http://x.y/z)").chars).toBe(1);
  });

  it("excludes front matter and math source", () => {
    expect(
      countText("---\ntitle: Hello World\ntags: [a, b]\n---\n\n正文").words,
    ).toBe(2);
    expect(countText("Area $\\pi r^2$ done").words).toBe(2);
  });

  it("returns zeros for an empty document; a trailing newline adds no line", () => {
    expect(countText("")).toEqual({
      words: 0,
      chars: 0,
      charsNoSpaces: 0,
      lines: 0,
      readingMinutes: 0,
    });
    expect(countText("a\nb\n").lines).toBe(2);
    expect(countText("a\nb").lines).toBe(2);
    expect(countLines("\n")).toBe(1);
    expect(countText("a\n\n").lines).toBe(2);
  });

  it("estimates reading time (CJK 400/min, other words 200/min, rounded up)", () => {
    expect(countText("字".repeat(400)).readingMinutes).toBe(1);
    expect(countText("字".repeat(401)).readingMinutes).toBe(2);
    expect(countText(Array(201).fill("word").join(" ")).readingMinutes).toBe(2);
    expect(
      countText("字".repeat(200) + " " + Array(100).fill("w").join(" "))
        .readingMinutes,
    ).toBe(1);
  });
});

describe("NV-03 selection counting", () => {
  it("counts the selection (sum of all ranges) using the editor tree", () => {
    const doc = "# 標題 Title\n\n**中文** and more words";
    const whole = countDocument(stateOf(doc));
    expect(whole.words).toBe(8); // 標 題 Title 中 文 and more words
    expect(countSelection(stateOf(doc))).toBeNull();

    const from = doc.indexOf("**");
    const sel = countSelection(
      stateOf(doc, EditorSelection.single(from, from + 6)),
    );
    expect(sel).toMatchObject({ words: 2, chars: 2, lines: 1 });

    const multi = countSelection(
      stateOf(
        doc,
        EditorSelection.create([
          EditorSelection.range(0, 9),
          EditorSelection.range(doc.length - 5, doc.length),
        ]),
      ),
    );
    expect(multi?.words).toBe(4); // 標 題 Title + words
    expect(multi?.lines).toBe(2);
  });

  it("labels the counter", () => {
    const s = (words: number) => ({
      words,
      chars: 0,
      charsNoSpaces: 0,
      lines: 0,
      readingMinutes: 0,
    });
    expect(counterLabel(s(1234), null)).toBe("1,234 字");
    expect(counterLabel(s(1234), s(56))).toBe("選取 56 / 1,234 字");
  });
});

describe("NV-03 status bar counter", () => {
  let view: EditorView | null = null;
  let counter: ReturnType<typeof createWordCounter> | null = null;

  afterEach(() => {
    counter?.destroy();
    view?.destroy();
    counter = null;
    view = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function setup(doc: string): HTMLElement {
    const parent = document.createElement("div");
    const bar = document.createElement("footer");
    document.body.append(parent, bar);
    view = new EditorView({ parent, state: stateOf(doc) });
    counter = createWordCounter({ view, parent: bar });
    return bar;
  }

  it("shows the document count, debounces document edits and counts selections at once", () => {
    vi.useFakeTimers();
    const bar = setup("Hello world 你好");
    const button = bar.querySelector<HTMLElement>(
      '[data-testid="word-count"]',
    )!;
    expect(button.textContent).toBe("4 字");

    view!.dispatch({
      changes: { from: view!.state.doc.length, insert: " more" },
    });
    expect(button.textContent).toBe("4 字");
    vi.advanceTimersByTime(DOC_COUNT_DEBOUNCE_MS);
    expect(button.textContent).toBe("5 字");

    view!.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(button.textContent).toBe("選取 1 / 5 字");
    view!.dispatch({ selection: { anchor: 0 } });
    expect(button.textContent).toBe("5 字");
  });

  it("does not count during IME composition, catches up afterwards", () => {
    vi.useFakeTimers();
    const bar = setup("abc");
    const button = bar.querySelector<HTMLElement>(
      '[data-testid="word-count"]',
    )!;
    view!.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    view!.dispatch({
      changes: { from: 3, insert: " 中文" },
      userEvent: "input.type.compose",
    });
    vi.advanceTimersByTime(DOC_COUNT_DEBOUNCE_MS * 2);
    expect(button.textContent).toBe("1 字");
    view!.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(DOC_COUNT_DEBOUNCE_MS);
    expect(button.textContent).toBe("3 字");
  });

  it("popover lists the five statistics, for the selection when there is one", () => {
    const bar = setup("Hello world\n\n第二行");
    const button = bar.querySelector<HTMLElement>(
      '[data-testid="word-count"]',
    )!;
    button.click();
    const popover = bar.querySelector<HTMLElement>(
      '[data-testid="word-count-popover"]',
    )!;
    expect(popover.hidden).toBe(false);
    const rows = () =>
      Array.from(popover.querySelectorAll("dt")).map(
        (dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent}`,
      );
    expect(rows()).toEqual([
      "字數=5",
      "字元=14",
      "字元（不含空白）=13",
      "行數=3",
      "閱讀時間=約 1 分鐘",
    ]);
    expect(popover.textContent).toContain("全文");

    view!.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(popover.textContent).toContain("選取範圍");
    expect(rows()[0]).toBe("字數=1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popover.hidden).toBe(true);
  });
});
