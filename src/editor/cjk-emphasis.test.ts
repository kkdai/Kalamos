import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { buildExportHtml } from "../export/html";
import {
  cjkAsteriskFlanking,
  cjkEmphasisExtension,
  isCjkChar,
} from "./cjk-emphasis";
import { renderCellInlineMarkdownToFragment } from "./tables";

const base = markdownLanguage.parser as MarkdownParser;
const cjk = base.configure([cjkEmphasisExtension]);

type Node = [name: string, text: string];

/** Emphasis / StrongEmphasis nodes (with their text) in document order. */
function emphasis(text: string, parser: MarkdownParser = cjk): Node[] {
  const out: Node[] = [];
  parser.parse(text).iterate({
    enter(n) {
      if (n.name === "Emphasis" || n.name === "StrongEmphasis") {
        out.push([n.name, text.slice(n.from, n.to)]);
      }
    },
  });
  return out;
}

describe("CJK emphasis flanking (#22)", () => {
  it("issue example: `中文**「粗體」**中文` is strong", () => {
    expect(emphasis("中文**「粗體」**中文")).toEqual([
      ["StrongEmphasis", "**「粗體」**"],
    ]);
    expect(emphasis("中文**「粗體」**中文", base)).toEqual([]);
  });

  it("issue example: `中文**粗體。**中文` is strong", () => {
    expect(emphasis("中文**粗體。**中文")).toEqual([
      ["StrongEmphasis", "**粗體。**"],
    ]);
    expect(emphasis("中文**粗體。**中文", base)).toEqual([]);
  });

  it("other full-width punctuation on the inner side", () => {
    for (const inner of [
      "『引用』",
      "（括號）",
      "驚嘆！",
      "疑問？",
      "冒號：",
      "列舉、",
      "逗號，",
      "分號；",
      "省略…",
    ]) {
      expect(emphasis(`前**${inner}**後`)).toEqual([
        ["StrongEmphasis", `**${inner}**`],
      ]);
    }
  });

  it("`*斜體*` variants", () => {
    expect(emphasis("中文*「斜體」*中文")).toEqual([
      ["Emphasis", "*「斜體」*"],
    ]);
    expect(emphasis("中文*斜體。*中文")).toEqual([["Emphasis", "*斜體。*"]]);
    expect(emphasis("中文*斜體*中文")).toEqual([["Emphasis", "*斜體*"]]);
  });

  it("`***粗斜***` produces emphasis + strong", () => {
    const nodes = emphasis("中文***「粗斜」***中文")
      .map(([n]) => n)
      .sort();
    expect(nodes).toEqual(["Emphasis", "StrongEmphasis"]);
  });

  it("Japanese / Korean neighbours", () => {
    expect(emphasis("これは**「重要」**です")).toEqual([
      ["StrongEmphasis", "**「重要」**"],
    ]);
    expect(emphasis("한국어**「굵게」**입니다")).toEqual([
      ["StrongEmphasis", "**「굵게」**"],
    ]);
  });

  it("nested in links, list items and table cells", () => {
    expect(emphasis("[中文**「粗體」**中文](https://example.com)")).toEqual([
      ["StrongEmphasis", "**「粗體」**"],
    ]);
    expect(emphasis("- 項目**「粗體」**結尾\n- 第二項**粗體。**後")).toEqual([
      ["StrongEmphasis", "**「粗體」**"],
      ["StrongEmphasis", "**粗體。**"],
    ]);
    expect(
      emphasis("| 欄 | 說明 |\n| --- | --- |\n| a | 中文**「粗體」**中文 |"),
    ).toEqual([["StrongEmphasis", "**「粗體」**"]]);
    const cell = renderCellInlineMarkdownToFragment("中文**「粗體」**中文");
    const strong = cell.querySelector(".k-strong, strong");
    expect(strong?.textContent).toBe("「粗體」");
  });

  it("ASCII behaviour is unchanged", () => {
    const cases = [
      "a**b**c",
      "foo**bar",
      "2*3*4",
      '**"quoted"**text',
      'a**"b"**c',
      "x * y * z",
      "**bold** and *em*",
      "*(a)*b",
      "snake_case_name and __strong__",
    ];
    for (const text of cases) {
      expect(emphasis(text), text).toEqual(emphasis(text, base));
    }
    expect(emphasis("a**b**c")).toEqual([["StrongEmphasis", "**b**"]]);
    expect(emphasis("foo**bar")).toEqual([]);
  });

  it("`_` stays strict (no CJK relaxation)", () => {
    for (const text of [
      "中文__「粗體」__中文",
      "中文_「斜體」_中文",
      "報告_v2_最終",
      "中文__粗體__中文",
    ]) {
      expect(emphasis(text), text).toEqual(emphasis(text, base));
    }
    expect(emphasis("中文__「粗體」__中文")).toEqual([]);
  });

  it("whitespace still blocks flanking", () => {
    expect(emphasis("中文** 粗體 **中文")).toEqual([]);
    expect(cjkAsteriskFlanking("中", " ")).toEqual({
      canOpen: false,
      canClose: true,
    });
  });

  it("isCjkChar covers CJK punctuation and full-width forms", () => {
    for (const ch of [
      "中",
      "あ",
      "カ",
      "한",
      "ㄅ",
      "「",
      "。",
      "　",
      "Ａ",
      "！",
      "𠀀",
    ]) {
      expect(isCjkChar(ch), ch).toBe(true);
    }
    for (const ch of ["a", "1", "!", " ", "", "é"]) {
      expect(isCjkChar(ch), ch).toBe(false);
    }
  });

  it("export HTML renders the CJK examples as <strong>", async () => {
    const { html } = await buildExportHtml(
      "中文**「粗體」**中文\n\n中文**粗體。**中文",
      {
        title: "t",
        docPath: null,
      },
    );
    expect(html).toContain("<strong>「粗體」</strong>");
    expect(html).toContain("<strong>粗體。</strong>");
    expect(html).not.toContain("**");
  });
});
