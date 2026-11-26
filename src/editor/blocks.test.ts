import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportHtml } from "../export/html";
import { extractOutlineHeadings } from "../sidebar/outline";
import {
  blocksExtension,
  collectBlockSpecs,
  findTocParagraphs,
  footnoteAt,
  footnoteIndexField,
  nestTocEntries,
  tocField,
} from "./blocks";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";
import { ensureFullSyntaxTree } from "./test-utils";

const md = () =>
  markdown({
    base: markdownLanguage,
    addKeymap: false,
    extensions: [
      mathMarkdownExtension,
      frontMatterExtension,
      footnoteExtension,
    ],
  });

function makeState(doc: string, cursor = doc.length): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [md(), blocksExtension],
  });
  return ensureFullSyntaxTree(state);
}

function nodeNames(state: EditorState): string[] {
  const names: string[] = [];
  const tree = syntaxTree(ensureFullSyntaxTree(state));
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling)
    names.push(n.name);
  return names;
}

function specs(state: EditorState) {
  return collectBlockSpecs(
    state,
    [{ from: 0, to: state.doc.length }],
    state.field(footnoteIndexField).index,
  );
}

function spanText(state: EditorState, s: { from: number; to: number }): string {
  return state.sliceDoc(s.from, s.to);
}

describe("ED-06 parsing", () => {
  it("parses YAML front matter only at the very start, and never as hr / Setext", () => {
    const doc =
      "---\ntitle: Hello\ntags: [a, b]\n---\n\n# H1\n\nPara\n---\n\n***\n";
    expect(nodeNames(makeState(doc))).toEqual([
      "FrontMatter",
      "ATXHeading1",
      "SetextHeading2",
      "HorizontalRule",
    ]);
    // `...` also closes; an unclosed `---` at the start is a plain rule.
    expect(nodeNames(makeState("---\na: 1\n...\ntext"))).toEqual([
      "FrontMatter",
      "Paragraph",
    ]);
    expect(nodeNames(makeState("---\nno close\n\ntext"))).toEqual([
      "HorizontalRule",
      "Paragraph",
      "Paragraph",
    ]);
    // Not at the start → not front matter.
    expect(nodeNames(makeState("intro\n\n---\na: 1\n---\n"))[0]).toBe(
      "Paragraph",
    );
  });

  it("keeps `---` after a paragraph a Setext heading", () => {
    expect(nodeNames(makeState("Title\n---\n\ntext"))).toEqual([
      "SetextHeading2",
      "Paragraph",
    ]);
  });

  it("excludes front matter from the outline", () => {
    const state = makeState("---\ntitle: x\n# not a heading\n---\n\n# Real\n");
    expect(extractOutlineHeadings(state).map((h) => h.text)).toEqual(["Real"]);
  });

  it("numbers footnotes by first reference; undefined references are not footnotes", () => {
    const doc =
      "A[^b] B[^a] C[^b] D[^nope]\n\n[^a]: first *def*\n[^b]: second\n    continued\n[^unused]: x\n";
    const state = makeState(doc, 0);
    const { index } = state.field(footnoteIndexField);
    expect(index.order).toEqual(["b", "a"]);
    expect(index.numbers.get("b")).toBe(1);
    expect(index.numbers.get("a")).toBe(2);
    expect(index.numbers.has("nope")).toBe(false);
    expect(index.numbers.has("unused")).toBe(false);
    expect(nodeNames(state)).toEqual([
      "Paragraph",
      "FootnoteDefinition",
      "FootnoteDefinition",
      "FootnoteDefinition",
    ]);
  });
});

describe("ED-06 decorations", () => {
  it("hides `>` markers outside the cursor line and nests quote borders", () => {
    const doc = "> outer\n> > inner\n\nafter";
    let state = makeState(doc, doc.length);
    let s = specs(state);
    const lines = s
      .filter((x) => x.kind === "line")
      .map((x) => [x.from, x.className]);
    expect(lines).toEqual([
      [0, "k-quote-line k-quote-depth-1"],
      [8, "k-quote-line k-quote-depth-2"],
    ]);
    const hidden = s
      .filter((x) => x.className === "k-mark-hidden")
      .map((x) => spanText(state, x));
    expect(hidden).toEqual(["> ", "> ", "> "]);

    // #49: cursor in the quoted text keeps every `>` hidden…
    state = makeState(doc, 3);
    expect(
      specs(state).filter((x) => x.className === "k-mark-hidden"),
    ).toHaveLength(3);

    // …only the cursor on a `>` itself reveals that marker.
    state = makeState(doc, 1);
    s = specs(state);
    const marks = s.filter((x) => x.kind === "mark");
    expect(marks.find((x) => x.from === 0)?.className).toBe("k-mark");
    expect(marks.filter((x) => x.className === "k-mark-hidden")).toHaveLength(
      2,
    );
  });

  it("renders a horizontal rule as a widget unless the cursor is on it", () => {
    const doc = "a\n\n---\n\nb";
    expect(specs(makeState(doc, 0)).find((x) => x.kind === "hr")).toMatchObject(
      { from: 3, to: 6 },
    );
    const onRule = specs(makeState(doc, 4));
    expect(onRule.find((x) => x.kind === "hr")).toBeUndefined();
    expect(onRule.find((x) => x.from === 3)?.className).toBe("k-mark");
  });

  it("styles front matter lines as a box", () => {
    const doc = "---\ntitle: x\n---\n\ntext";
    const s = specs(makeState(doc));
    expect(s.filter((x) => x.kind === "line").map((x) => x.className)).toEqual([
      "k-frontmatter-line k-frontmatter-first",
      "k-frontmatter-line",
      "k-frontmatter-line k-frontmatter-last",
    ]);
    expect(s.find((x) => x.kind === "hr")).toBeUndefined();
  });

  it("replaces defined footnote references with numbers; reveals source under the cursor", () => {
    const doc = "Text[^n] and[^x].\n\n[^n]: The note.";
    const outside = specs(makeState(doc, doc.length));
    const refs = outside.filter((x) => x.kind === "footnote");
    expect(refs).toEqual([
      { kind: "footnote", from: 4, to: 8, footnoteId: "n", footnoteNumber: 1 },
    ]);
    // `[^x]` has no definition: no decoration at all (stays literal).
    expect(outside.some((x) => x.from === 12)).toBe(false);

    const inside = specs(makeState(doc, 6));
    expect(inside.find((x) => x.from === 4)?.className).toBe(
      "k-footnote-ref-src",
    );
  });

  it("finds the footnote under the pointer for the hover tooltip", () => {
    const doc = "See[^1] here.\n\n[^1]: Footnote **body**\n    more.";
    const state = makeState(doc, doc.length);
    expect(footnoteAt(state, 5)).toEqual({
      id: "1",
      from: 3,
      to: 7,
      text: "Footnote **body** more.",
    });
    expect(footnoteAt(state, 10)).toBeNull();
    expect(footnoteAt(makeState("x[^q]", 0), 2)).toBeNull();
  });
});

describe("ED-07 [TOC]", () => {
  it("finds top-level [TOC] paragraphs (case-insensitive) and nests entries", () => {
    const state = makeState("[toc]\n\n# A\n\n### C\n\n## B\n\n- [TOC]\n");
    expect(findTocParagraphs(state)).toEqual([{ from: 0, to: 5 }]);
    const field = state.field(tocField);
    expect(field.entries.map((e) => e.slug)).toEqual(["a", "c", "b"]);
    expect(nestTocEntries(field.entries)).toMatchObject([
      {
        slug: "a",
        children: [
          { slug: "c", children: [] },
          { slug: "b", children: [] },
        ],
      },
    ]);
  });

  it("updates immediately when a heading is added", () => {
    let state = makeState("[TOC]\n\n# One\n", 0);
    expect(state.field(tocField).entries.map((e) => e.text)).toEqual(["One"]);
    state = ensureFullSyntaxTree(
      state.update({
        changes: { from: state.doc.length, insert: "\n## Two\n" },
      }).state,
    );
    expect(state.field(tocField).entries.map((e) => e.text)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("replaces the [TOC] paragraph with a block widget, and keeps the source visible under the cursor", () => {
    const doc = "intro\n\n[TOC]\n\n# One";
    const outside = makeState(doc, 0).field(tocField).decorations;
    const ranges: Array<[number, number, boolean]> = [];
    outside.between(0, doc.length, (from, to, deco) => {
      ranges.push([from, to, Boolean(deco.spec.block)]);
    });
    expect(ranges).toEqual([[7, 12, true]]);

    const inside = makeState(doc, 9).field(tocField).decorations;
    const insideRanges: Array<[number, number]> = [];
    inside.between(0, doc.length, (from, to) => {
      insideRanges.push([from, to]);
    });
    expect(insideRanges).toEqual([[12, 12]]);
  });

  it("does not rebuild while composing (IME)", () => {
    let state = makeState("[TOC]\n\n# One\n", 0);
    const before = state.field(tocField);
    state = state.update({
      changes: { from: state.doc.length, insert: "# 新" },
      userEvent: "input.type.compose",
    }).state;
    const during = state.field(tocField);
    expect(during.entries).toBe(before.entries);
    expect(during.dirty).toBe(true);
    state = ensureFullSyntaxTree(state.update({}).state);
    expect(state.field(tocField).entries.map((e) => e.text)).toEqual([
      "One",
      "新",
    ]);
  });
});

describe("ED-06 / ED-07 in the editor DOM", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("renders the TOC widget and jumps to a heading on click", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "[TOC]\n\n# Alpha\n\ntext\n\n## Beta\n";
    view = new EditorView({
      parent,
      state: makeState(doc, doc.length),
    });
    const links = Array.from(
      parent.querySelectorAll<HTMLAnchorElement>(".k-toc a"),
    );
    expect(links.map((a) => a.textContent)).toEqual(["Alpha", "Beta"]);
    links[1].dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    expect(line.text).toBe("## Beta");
  });

  it("clicking a footnote number jumps to its definition", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "Body[^a].\n\n[^a]: Note text";
    view = new EditorView({
      parent,
      state: makeState(doc, doc.length),
    });
    const ref = parent.querySelector<HTMLElement>(".k-footnote-ref");
    expect(ref?.textContent).toBe("1");
    ref!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(view.state.selection.main.head).toBe(doc.indexOf("Note"));
  });
});

describe("ED-06 / ED-07 export", () => {
  it("skips front matter, renders footnotes and the TOC", async () => {
    const doc = [
      "---",
      "title: Secret",
      "---",
      "",
      "[TOC]",
      "",
      "# Alpha",
      "",
      "Text[^b] more[^a] again[^b] missing[^zz].",
      "",
      "## Beta",
      "",
      "> quote",
      "",
      "---",
      "",
      "[^a]: Note *A*",
      "[^b]: Note B",
    ].join("\n");
    const { html, headings } = await buildExportHtml(doc, {
      title: "t",
      docPath: null,
    });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).not.toContain("Secret");
    expect(headings.map((h) => h.text)).toEqual(["Alpha", "Beta"]);
    expect(body).toContain(
      '<nav class="k-toc">\n<ul>\n<li><a href="#alpha">Alpha</a><ul>\n<li><a href="#beta">Beta</a></li>\n</ul>\n</li>\n</ul>\n</nav>',
    );
    expect(body).toContain(
      'Text<sup class="k-fn-ref" id="fnref-1"><a href="#fn-1">1</a></sup>',
    );
    expect(body).toContain(
      'more<sup class="k-fn-ref" id="fnref-2"><a href="#fn-2">2</a></sup>',
    );
    expect(body).toContain(
      'again<sup class="k-fn-ref"><a href="#fn-1">1</a></sup>',
    );
    expect(body).toContain("missing[^zz].");
    expect(body).toContain(
      '<li id="fn-1">Note B <a class="k-fn-back" href="#fnref-1">↩</a></li>',
    );
    expect(body).toContain(
      '<li id="fn-2">Note <em>A</em> <a class="k-fn-back" href="#fnref-2">↩</a></li>',
    );
    expect(body).toContain("<blockquote>\n<p>quote</p>\n</blockquote>");
    expect(body).toContain("<hr>");
    expect(body).not.toContain("[^a]:");
  });
});
