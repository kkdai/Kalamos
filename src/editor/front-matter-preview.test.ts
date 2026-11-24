import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUiLocale, initUiLocale } from "../i18n";
import { frontMatterExtension } from "./front-matter";
import {
  finishFrontMatterEdit,
  frontMatterField,
  frontMatterPreviewExtension,
  getLoadedYamlModule,
  handleFrontMatterBackspace,
  handleFrontMatterDelete,
  loadYamlModule,
  parseFields,
  renderValue,
} from "./front-matter-preview";

const md = () =>
  markdown({
    base: markdownLanguage,
    addKeymap: false,
    extensions: [frontMatterExtension],
  });

function mountEditor(doc: string, cursor = doc.length): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [md(), frontMatterPreviewExtension],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return new EditorView({ state, parent });
}

describe("front-matter-preview lazy yaml loading", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("defers loading yaml until front matter is encountered, then renders without errors", async () => {
    expect(getLoadedYamlModule()).toBeNull();
    expect(parseFields("title: a\n")).toBeNull();

    // Document without front matter does not trigger loading.
    view = mountEditor("# Heading\n\nBody\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(getLoadedYamlModule()).toBeNull();
    view.destroy();
    view = null;

    // First document with front matter shows raw lines while pending, then renders card.
    const doc = "---\ntitle: Hello\n---\n\n# Body";
    view = mountEditor(doc, doc.length);
    expect(view.state.field(frontMatterField).preview?.pending).toBe(true);
    expect(view.dom.querySelector(".k-frontmatter-preview")).toBeNull();

    for (
      let i = 0;
      i < 50 && !view.dom.querySelector(".k-frontmatter-preview");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getLoadedYamlModule()).not.toBeNull();
    expect(view.state.field(frontMatterField).preview?.pending).toBe(false);
    expect(
      view.dom.querySelector(".k-frontmatter-preview dd")?.textContent,
    ).toBe("Hello");
  });
});

describe("parseFields", () => {
  it("distinguishes empty YAML null from empty string and preserves explicit null/tilde", async () => {
    await loadYamlModule();
    const fields = parseFields(
      [
        "empty_null:",
        'empty_double: ""',
        "empty_single: ''",
        "explicit_null: null",
        "tilde: ~",
        "list:",
        "  -",
        '  - ""',
      ].join("\n"),
    );
    expect(fields).toEqual({
      entries: [
        ["empty_null", null],
        ["empty_double", ""],
        ["empty_single", ""],
        ["explicit_null", "null"],
        ["tilde", "~"],
        ["list", [null, ""]],
      ],
    });
  });

  it("preserves original numeric and boolean source text (0x1F, 1.50, false)", async () => {
    await loadYamlModule();
    const fields = parseFields(
      ["hex: 0x1F", "decimal: 1.50", "flag: false", "count: 42"].join("\n"),
    );
    expect(fields).toEqual({
      entries: [
        ["hex", "0x1F"],
        ["decimal", "1.50"],
        ["flag", "false"],
        ["count", "42"],
      ],
    });
  });

  it("parses literal and folded block scalars", async () => {
    await loadYamlModule();
    const fields = parseFields(
      [
        "literal: |",
        "  line one",
        "  line two",
        "folded: >-",
        "  hello",
        "  world",
      ].join("\n"),
    );
    expect(fields).toEqual({
      entries: [
        ["literal", "line one\nline two\n"],
        ["folded", "hello world"],
      ],
    });
  });

  it("keeps aliases literal without expanding recursive references", async () => {
    await loadYamlModule();
    const fields = parseFields("notes: &notes [*notes]\n");
    expect(fields).toEqual({
      entries: [["notes", ["*notes"]]],
    });
  });

  it("returns null on duplicate keys", async () => {
    await loadYamlModule();
    expect(parseFields("a: 1\na: 2\n")).toBeNull();
  });

  it("returns null on unknown tags (YAML warnings)", async () => {
    await loadYamlModule();
    expect(parseFields("a: !custom foo\n")).toBeNull();
  });

  it("returns null on malformed YAML, non-map roots, empty docs, and non-scalar keys", async () => {
    await loadYamlModule();
    expect(parseFields("tags: [broken\n")).toBeNull();
    expect(parseFields("- a\n- b\n")).toBeNull();
    expect(parseFields("just a string\n")).toBeNull();
    expect(parseFields("")).toBeNull();
    expect(parseFields("# only comment\n")).toBeNull();
    expect(parseFields("[1, 2]: value\n")).toBeNull();
  });

  it("enforces the node budget (512 nodes)", async () => {
    await loadYamlModule();
    // 1 root map + 1 seq + 510 scalar items = 512 nodes (fits budget).
    const within = `items: [${Array.from({ length: 510 }, (_, i) => i).join(", ")}]\n`;
    expect(parseFields(within)).not.toBeNull();

    // 1 root map + 1 seq + 511 scalar items = 513 nodes (exceeds budget).
    const over = `items: [${Array.from({ length: 511 }, (_, i) => i).join(", ")}]\n`;
    expect(parseFields(over)).toBeNull();
  });

  it("enforces the nesting depth limit (max depth 10)", async () => {
    await loadYamlModule();
    const buildNested = (levels: number): string => {
      let out = "";
      for (let i = 0; i < levels; i++) {
        out += `${"  ".repeat(i)}k${i}:\n`;
      }
      out += `${"  ".repeat(levels)}leaf: ok\n`;
      return out;
    };
    // Root map is depth 0; 9 nested maps reach depth 9, leaf scalar at depth 10 (allowed).
    expect(parseFields(buildNested(9))).not.toBeNull();
    // 10 nested maps push leaf scalar to depth 11 (rejected).
    expect(parseFields(buildNested(10))).toBeNull();
  });

  it("returns null when yaml module is explicitly null", () => {
    expect(parseFields("title: a\n", null)).toBeNull();
  });
});

describe("renderValue", () => {
  it("renders null as em-dash and empty string as empty quotes", () => {
    const nullNode = renderValue(document, null);
    expect(nullNode.textContent).toBe("—");

    const emptyNode = renderValue(document, "");
    expect(emptyNode.textContent).toBe('""');
  });

  it("escapes HTML-like strings as text nodes and renders empty containers", () => {
    const html = renderValue(document, "<em>raw</em>");
    expect(html.nodeType).toBe(Node.TEXT_NODE);
    expect(html.textContent).toBe("<em>raw</em>");

    expect(renderValue(document, []).textContent).toBe("[]");
    expect(renderValue(document, { entries: [] }).textContent).toBe("{}");

    const dl = renderValue(document, {
      entries: [
        ["", null],
        ["empty", ""],
      ],
    }) as HTMLElement;
    expect(
      Array.from(dl.querySelectorAll("dt")).map((e) => e.textContent),
    ).toEqual(['""', "empty"]);
    expect(
      Array.from(dl.querySelectorAll("dd")).map((e) => e.textContent),
    ).toEqual(["—", '""']);
  });
});

describe("front matter Backspace / Delete and focus behavior", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    vi.restoreAllMocks();
  });

  it("Backspace at preview.to + 1 enters edit mode at closing fence end without modifying doc", async () => {
    await loadYamlModule();
    const doc = "---\ntitle: a\n---\n# H";
    const bodyStart = doc.indexOf("# H");
    const fenceEnd = bodyStart - 1;
    view = mountEditor(doc, bodyStart);

    expect(view.state.field(frontMatterField).editing).toBe(false);
    expect(handleFrontMatterBackspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.field(frontMatterField).editing).toBe(true);
    expect(view.state.selection.main.head).toBe(fenceEnd);

    // Once editing, Backspace falls through to normal deletion.
    expect(handleFrontMatterBackspace(view)).toBe(false);
  });

  it("Backspace elsewhere or with non-empty selection falls through", async () => {
    await loadYamlModule();
    const doc = "---\ntitle: a\n---\n# H";
    const bodyStart = doc.indexOf("# H");
    view = mountEditor(doc, bodyStart + 1);
    expect(handleFrontMatterBackspace(view)).toBe(false);

    // Non-empty selection starting at preview.to + 1.
    view.dispatch({ selection: { anchor: bodyStart, head: doc.length } });
    expect(handleFrontMatterBackspace(view)).toBe(false);

    // Cursor at 0 on fresh open.
    view.dispatch({ selection: { anchor: 0 } });
    expect(handleFrontMatterBackspace(view)).toBe(false);
  });

  it("Delete at preview.to enters edit if collapsed, and falls through while editing", async () => {
    await loadYamlModule();
    const doc = "---\ntitle: a\n---\n# H";
    const fenceEnd = doc.indexOf("# H") - 1;
    view = mountEditor(doc, fenceEnd);

    // Moving cursor to preview.to enters editing naturally -> Delete falls through.
    expect(view.state.field(frontMatterField).editing).toBe(true);
    expect(handleFrontMatterDelete(view)).toBe(false);

    // If collapsed while cursor remains at preview.to, Delete expands without deleting.
    view.setState(finishFrontMatterEdit(view.state));
    expect(view.state.field(frontMatterField).editing).toBe(false);
    expect(view.state.selection.main.head).toBe(fenceEnd);
    expect(handleFrontMatterDelete(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.field(frontMatterField).editing).toBe(true);
    expect(view.state.selection.main.head).toBe(fenceEnd);
  });

  it("Delete at cursor 0 in preview mode expands card at editPosition without modifying doc", async () => {
    await loadYamlModule();
    const doc = "---\ntitle: a\n---\n# H";
    view = mountEditor(doc, 0);
    expect(view.state.field(frontMatterField).editing).toBe(false);
    expect(handleFrontMatterDelete(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.field(frontMatterField).editing).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("title: a"));
  });

  it("keeps editing open when window loses focus (app switch), collapses on in-app blur", async () => {
    await loadYamlModule();
    const doc = "---\ntitle: a\n---\n\nBody";
    view = mountEditor(doc, doc.indexOf("title: a"));
    expect(view.state.field(frontMatterField).editing).toBe(true);

    const effects = view.state.facet(EditorView.focusChangeEffect);

    // App switch: document.hasFocus() is false -> stay in edit mode.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const onAppSwitch = effects
      .map((fn) => fn(view!.state, false))
      .filter(Boolean);
    expect(onAppSwitch).toEqual([]);

    // In-app blur: document.hasFocus() is true -> collapse card.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const onInAppBlur = effects
      .map((fn) => fn(view!.state, false))
      .filter(Boolean);
    expect(onInAppBlur.length).toBe(1);
    view.dispatch({ effects: onInAppBlur as never });
    expect(view.state.field(frontMatterField).editing).toBe(false);
  });

  it("localizes the preview card heading and edit button aria-label", async () => {
    await loadYamlModule();
    const prev = getUiLocale();
    const doc = "---\ntitle: Hello\n---\n\nBody";
    try {
      initUiLocale("zh-TW");
      view = mountEditor(doc, doc.length);
      expect(
        view.dom.querySelector(".k-frontmatter-preview > strong")?.textContent,
      ).toBe("文件資訊");
      expect(
        view.dom
          .querySelector(".k-frontmatter-edit")
          ?.getAttribute("aria-label"),
      ).toBe("編輯文件資訊");
      view.destroy();
      view = null;

      initUiLocale("en");
      view = mountEditor(doc, doc.length);
      expect(
        view.dom.querySelector(".k-frontmatter-preview > strong")?.textContent,
      ).toBe("Document info");
      expect(
        view.dom
          .querySelector(".k-frontmatter-edit")
          ?.getAttribute("aria-label"),
      ).toBe("Edit document info");
    } finally {
      initUiLocale(prev);
    }
  });
});
