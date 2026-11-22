import {
  CompletionContext,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp } from "../main";
import {
  type EmojiIndex,
  emojiCompletionSource,
  emojiExtension,
  getLoadedEmojiIndex,
  isExcludedEmojiContext,
  loadEmojiIndex,
  MAX_EMOJI_OPTIONS,
  searchEmoji,
  shortcodeBefore,
} from "./emoji";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";

function stateOf(doc: string, cursor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: [mathMarkdownExtension, frontMatterExtension],
      }),
    ],
  });
}

async function complete(doc: string, cursor = doc.length) {
  return emojiCompletionSource(
    new CompletionContext(stateOf(doc, cursor), cursor, false),
  );
}

let index: EmojiIndex;

beforeAll(async () => {
  index = await loadEmojiIndex();
});

describe("ED-08 emoji data and ranking", () => {
  it("loads gemoji lazily and indexes every shortcode", () => {
    expect(getLoadedEmojiIndex()).toBe(index);
    expect(index.byName.get("smile")).toBe("😄");
    expect(index.byName.get("+1")).toBe("👍");
    expect(index.entries.length).toBeGreaterThan(1500);
  });

  it("ranks prefix matches before substring matches, shorter first, max 50", () => {
    const names = searchEmoji(index, "smile").map((e) => e.name);
    expect(names[0]).toBe("smile");
    const firstSubstring = names.findIndex((n) => !n.startsWith("smile"));
    expect(firstSubstring).toBeGreaterThan(0);
    expect(
      names
        .slice(firstSubstring)
        .every((n) => n.includes("smile") && !n.startsWith("smile")),
    ).toBe(true);
    expect(
      names.slice(0, firstSubstring).every((n) => n.startsWith("smile")),
    ).toBe(true);
    expect(searchEmoji(index, "a").length).toBe(MAX_EMOJI_OPTIONS);
    expect(searchEmoji(index, "zzzzzz")).toEqual([]);
  });
});

describe("ED-08 trigger contexts", () => {
  it("`:smile` shows candidates with the emoji and :name:", async () => {
    const result = await complete("今天很開心 :smile");
    expect(result).not.toBeNull();
    expect(result!.from).toBe("今天很開心 ".length);
    const first = result!.options[0] as {
      label: string;
      apply: string;
      emoji: string;
    };
    expect(first.label).toBe(":smile:");
    expect(first.apply).toBe("😄");
    expect(first.emoji).toBe("😄");
    expect(result!.options.length).toBeLessThanOrEqual(MAX_EMOJI_OPTIONS);
  });

  it("works at line start, after CJK punctuation and inside emphasis / lists", async () => {
    for (const doc of [
      ":sm",
      "好。:sm",
      "**粗體 :sm",
      "- 項目 :sm",
      "> 引用 :sm",
    ]) {
      expect(await complete(doc), doc).not.toBeNull();
    }
  });

  it("needs at least two characters", async () => {
    expect(await complete("a :s")).toBeNull();
    expect(await complete("a :")).toBeNull();
  });

  it("is excluded after letters / digits, in code, math, URLs, HTML and front matter", async () => {
    const excluded = [
      "時間 12:30",
      "see http:sm",
      "a:smile",
      "文字:smile",
      "`code :smile",
      "```\n:smile",
      "    indented :smile",
      "$$\n:smile",
      "<https://example.com/:smile",
      "[a](https://x.test/:smile",
      "<div :smile",
    ];
    for (const doc of excluded) {
      expect(await complete(doc), doc).toBeNull();
    }
    const fm = "---\ntitle: :smile";
    expect(await complete(fm), fm).toBeNull();
    // Inside closed inline math (an unclosed `$` may be a currency sign, so it is not guessed).
    const math = "公式 $x :smile$ 後";
    expect(await complete(math, math.indexOf("$ 後")), math).toBeNull();
    expect(await complete("價格 $5 :smile"), "currency").not.toBeNull();
  });

  it("isExcludedEmojiContext agrees for the shortcode position", () => {
    expect(isExcludedEmojiContext(stateOf("a :x"), 2)).toBe(false);
    expect(isExcludedEmojiContext(stateOf("10:30"), 2)).toBe(true);
    expect(isExcludedEmojiContext(stateOf("`a :x`"), 3)).toBe(true);
  });
});

describe("ED-08 `:name:` conversion", () => {
  it("a known shortcode followed by `:` becomes the emoji", () => {
    const doc = "開心 :smile";
    expect(shortcodeBefore(stateOf(doc), doc.length, index)).toEqual({
      from: 3,
      emoji: "😄",
    });
    expect(shortcodeBefore(stateOf(":+1"), 3, index)).toEqual({
      from: 0,
      emoji: "👍",
    });
  });

  it("unknown shortcodes and excluded contexts stay untouched", () => {
    expect(shortcodeBefore(stateOf("a :foo"), 6, index)).toBeNull();
    expect(shortcodeBefore(stateOf("10:30"), 5, index)).toBeNull();
    expect(shortcodeBefore(stateOf("`x :smile"), 9, index)).toBeNull();
  });
});

describe("ED-08 in an editor", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mount(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [markdown({ base: markdownLanguage }), emojiExtension],
      }),
      parent,
    });
  }

  function typeChar(v: EditorView, ch: string): void {
    const { from, to } = v.state.selection.main;
    const insert = () =>
      v.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + 1 },
        userEvent: "input.type",
      });
    if (
      !v.state
        .facet(EditorView.inputHandler)
        .some((h) => h(v, from, to, ch, insert))
    )
      v.dispatch(insert());
  }

  it("the completion list opens for :smile and accepting inserts the emoji", async () => {
    view = mount("哈 :smile");
    startCompletion(view);
    for (
      let i = 0;
      i < 50 && currentCompletions(view.state).length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const options = currentCompletions(view.state);
    expect(options[0]?.label).toBe(":smile:");
    // Apply the first option the way CodeMirror does.
    const apply = options[0].apply as string;
    view.dispatch({
      changes: { from: 2, to: view.state.doc.length, insert: apply },
    });
    expect(view.state.doc.toString()).toBe("哈 😄");
  });

  it("typing the closing colon converts a known shortcode, keeps unknown ones", () => {
    view = mount("哈 :smile");
    typeChar(view, ":");
    expect(view.state.doc.toString()).toBe("哈 😄");
    expect(view.state.selection.main.head).toBe("哈 😄".length);
    typeChar(view, " ");
    for (const ch of ":foo:") typeChar(view, ch);
    expect(view.state.doc.toString()).toBe("哈 😄 :foo:");
  });

  it("the app editor offers no HTML tag completion for <di, but still completes emoji", async () => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
    const app = createKalamosApp(document);
    await app.init();
    const v = app.editor.view;
    const waitForOptions = async () => {
      for (let i = 0; i < 30 && currentCompletions(v.state).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return currentCompletions(v.state);
    };
    try {
      app.editor.setContent("段落 <di");
      app.editor.setCursor(v.state.doc.length);
      startCompletion(v);
      expect(await waitForOptions()).toEqual([]);

      app.editor.setContent("段落 :smi");
      app.editor.setCursor(v.state.doc.length);
      startCompletion(v);
      expect((await waitForOptions())[0]?.label).toBe(":smile:");
    } finally {
      app.destroy();
    }
  });
});
