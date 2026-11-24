import { undo } from "@codemirror/commands";
import {
  getSearchQuery,
  SearchQuery,
  searchPanelOpen,
} from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUiLocale, initUiLocale } from "../i18n";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  closeFind,
  collectMatches,
  currentMatchIndex,
  findMatchFrom,
  findNextMatch,
  findPreviousMatch,
  matchLabel,
  openFind,
  regexError,
  replaceAllMatches,
  replaceCurrent,
  selectionToQueryText,
  tableHitAt,
  useSelectionForFind,
} from "./search";
import { getActiveTableCell } from "./tables";

/** #73 A: find & replace in the current document. */

const st = (doc: string) => EditorState.create({ doc });

describe("#73 query helpers", () => {
  it("collectMatches: plain, case-sensitive, whole word, regex", () => {
    const s = st("Foo foo food FOO");
    expect(
      collectMatches(s, new SearchQuery({ search: "foo" })).ranges,
    ).toHaveLength(4);
    expect(
      collectMatches(s, new SearchQuery({ search: "foo", caseSensitive: true }))
        .ranges,
    ).toEqual([
      { from: 4, to: 7 },
      { from: 8, to: 11 },
    ]);
    expect(
      collectMatches(s, new SearchQuery({ search: "foo", wholeWord: true }))
        .ranges,
    ).toHaveLength(3);
    expect(
      collectMatches(s, new SearchQuery({ search: "fo+d", regexp: true }))
        .ranges,
    ).toEqual([{ from: 8, to: 12 }]);
  });

  it("collectMatches skips empty regex matches, caps, and never throws on an invalid regex", () => {
    const s = st("aaa");
    expect(
      collectMatches(s, new SearchQuery({ search: "x*", regexp: true })).ranges,
    ).toEqual([]);
    const capped = collectMatches(s, new SearchQuery({ search: "a" }), 2);
    expect(capped).toEqual({
      ranges: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ],
      capped: true,
    });
    expect(
      collectMatches(s, new SearchQuery({ search: "(", regexp: true })),
    ).toEqual({ ranges: [], capped: false });
  });

  it("finds CJK text", () => {
    const s = st("中文搜尋：搜尋結果");
    expect(
      collectMatches(s, new SearchQuery({ search: "搜尋" })).ranges,
    ).toEqual([
      { from: 2, to: 4 },
      { from: 5, to: 7 },
    ]);
  });

  it("findMatchFrom wraps around to the top", () => {
    const s = st("ab ab ab");
    const q = new SearchQuery({ search: "ab" });
    expect(findMatchFrom(s, q, 1)).toEqual({ from: 3, to: 5 });
    expect(findMatchFrom(s, q, 7)).toEqual({ from: 0, to: 2 });
    expect(findMatchFrom(s, new SearchQuery({ search: "zz" }), 0)).toBeNull();
  });

  it("currentMatchIndex", () => {
    const ranges = [
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 8 },
    ];
    expect(currentMatchIndex(ranges, { from: 6, to: 8 })).toBe(2);
    expect(currentMatchIndex(ranges, { from: 3, to: 4 })).toBe(-1);
    expect(currentMatchIndex([], { from: 0, to: 0 })).toBe(-1);
  });

  it("matchLabel: n / total, 無結果, invalid regex", () => {
    const q = new SearchQuery({ search: "a" });
    expect(matchLabel({ query: q, total: 12, capped: false, current: 2 })).toBe(
      "3 / 12",
    );
    expect(
      matchLabel({ query: q, total: 12, capped: false, current: -1 }),
    ).toBe("? / 12");
    expect(
      matchLabel({ query: q, total: 9999, capped: true, current: 0 }),
    ).toBe("1 / 9999+");
    expect(matchLabel({ query: q, total: 0, capped: false, current: -1 })).toBe(
      "無結果",
    );
    expect(
      matchLabel({
        query: new SearchQuery({ search: "" }),
        total: 0,
        capped: false,
        current: -1,
      }),
    ).toBe("");
    const bad = new SearchQuery({ search: "[", regexp: true });
    expect(bad.valid).toBe(false);
    expect(
      matchLabel({ query: bad, total: 0, capped: false, current: -1 }),
    ).toBe("正規表示式無效");
    expect(regexError("[")).toBeTruthy();
    expect(regexError("a+")).toBeNull();
  });

  it("selectionToQueryText escapes so the selection matches itself", () => {
    const text = "a.b*(c)\\d\nx";
    const s = st(`zz ${text} zz`);
    for (const regexp of [false, true]) {
      const q = new SearchQuery({
        search: selectionToQueryText(text, regexp),
        regexp,
      });
      expect(collectMatches(s, q).ranges).toEqual([
        { from: 3, to: 3 + text.length },
      ]);
    }
  });

  it("tableHitAt: only hits fully inside one cell", () => {
    const doc = "x\n\n| a | bb |\n| --- | --- |\n| cc | d |\n";
    const s = st(doc);
    const bb = doc.indexOf("bb");
    expect(tableHitAt(s, bb, bb + 2)).toMatchObject({ row: 0, col: 1 });
    const cc = doc.indexOf("cc");
    expect(tableHitAt(s, cc, cc + 2)).toMatchObject({ row: 1, col: 0 });
    expect(tableHitAt(s, 0, 1)).toBeNull();
    expect(tableHitAt(s, cc, doc.indexOf("d |") + 1)).toBeNull();
  });
});

it("localizes the search panel and CodeMirror announcements in English", async () => {
  const previousLocale = getUiLocale();
  await initUiLocale("en");
  document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
  const app = createKalamosApp(document);
  try {
    const { view } = app.editor;
    openFind(view, { replace: true });
    expect(
      document
        .querySelector('[data-testid="search-input"]')
        ?.getAttribute("placeholder"),
    ).toBe("Find");
    expect(
      document.querySelector('[data-testid="replace-all"]')?.textContent,
    ).toBe("Replace all");
    expect(view.state.phrase("replaced $ matches", 6)).toBe(
      "Replaced 6 matches",
    );
  } finally {
    app.destroy();
    await initUiLocale(previousLocale);
  }
});

const DOC = [
  "第一段 apple 與 Apple。",
  "",
  "**粗體 apple** 與 [連結 apple](https://example.com/apple)",
  "",
  "| 名稱 | 數量 |",
  "| --- | --- |",
  "| apple | 1 |",
  "",
  "```js",
  "const apple = 1;",
  "```",
  "",
  "end",
].join("\n");

describe("#73 find & replace in the real editor", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent(DOC);
    app.editor.setCursor(0);
    app.editor.view.focus();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  const view = () => app!.editor.view;
  const panel = () =>
    document.querySelector<HTMLElement>('[data-testid="search-panel"]');
  const input = (id: string) =>
    document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  const count = () =>
    document.querySelector('[data-testid="search-count"]')!.textContent;
  const selected = () => {
    const sel = view().state.selection.main;
    return {
      from: sel.from,
      to: sel.to,
      text: view().state.sliceDoc(sel.from, sel.to),
    };
  };
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  function typeQuery(el: HTMLInputElement, value: string, composing = false) {
    el.value = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: composing }),
    );
  }
  function key(el: Element, k: string, init: KeyboardEventInit = {}) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  }

  it("Cmd+F opens the bar and focuses the field; typing selects the first hit and counts", () => {
    // jsdom is not macOS, so CodeMirror's Mod is Ctrl here.
    key(view().contentDOM, "f", { ctrlKey: true, code: "KeyF" });
    expect(searchPanelOpen(view().state)).toBe(true);
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(input("search-input"));
    typeQuery(input("search-input"), "apple");
    expect(selected().text.toLowerCase()).toBe("apple");
    // 2 in the first paragraph, 3 in the bold/link line, 1 in the table, 1 in code.
    expect(count()).toBe("1 / 7");
  });

  it("uses the selection as the query (Cmd+F and Cmd+E)", () => {
    const pos = DOC.indexOf("Apple");
    view().dispatch({ selection: { anchor: pos, head: pos + 5 } });
    openFind(view());
    expect(input("search-input").value).toBe("Apple");
    closeFind(view());
    const p2 = DOC.indexOf("粗體");
    view().dispatch({ selection: { anchor: p2, head: p2 + 2 } });
    expect(useSelectionForFind(view())).toBe(true);
    expect(getSearchQuery(view().state).search).toBe("粗體");
  });

  it("Enter / Shift+Enter / Cmd+G / Cmd+Shift+G move between hits and wrap", () => {
    openFind(view());
    const field = input("search-input");
    typeQuery(field, "apple");
    expect(count()).toBe("1 / 7");
    key(field, "Enter");
    expect(count()).toBe("2 / 7");
    key(field, "Enter", { shiftKey: true });
    expect(count()).toBe("1 / 7");
    key(field, "Enter", { shiftKey: true });
    expect(count()).toBe("7 / 7");
    expect(selected().from).toBe(DOC.indexOf("apple = 1"));
    key(field, "g", { metaKey: true, code: "KeyG" });
    expect(count()).toBe("1 / 7");
    key(field, "g", { metaKey: true, shiftKey: true, code: "KeyG" });
    expect(count()).toBe("7 / 7");
  });

  it("hits in bold text, link text, link URL and code blocks are selected", () => {
    openFind(view());
    typeQuery(input("search-input"), "apple");
    const expected = [
      DOC.indexOf("apple"),
      DOC.indexOf("Apple"),
      DOC.indexOf("apple**"),
      DOC.indexOf("apple]"),
      DOC.indexOf("apple)"),
      DOC.indexOf("| apple") + 2,
      DOC.indexOf("apple = 1"),
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(selected().from).toBe(expected[i]);
      findNextMatch(view());
    }
  });

  it("options: case sensitive, whole word, regex; invalid regex shows a hint", () => {
    openFind(view());
    const field = input("search-input");
    typeQuery(field, "Apple");
    input("search-case").click();
    expect(count()).toBe("1 / 1");
    input("search-case").click();
    typeQuery(field, "app");
    // Searching continues from the current hit ("Apple", the 2nd).
    expect(count()).toBe("2 / 7");
    input("search-word").click();
    expect(count()).toBe("無結果");
    input("search-word").click();
    input("search-regex").click();
    typeQuery(field, "app(le");
    expect(count()).toBe("正規表示式無效");
    expect(
      panel()!.querySelector(".k-search-field")!.getAttribute("data-invalid"),
    ).toBe("true");
    typeQuery(field, "a(p+)le");
    expect(count()).toMatch(/^\d \/ 7$/);
  });

  it("IME: no search while composing; searches on compositionend", () => {
    openFind(view());
    const field = input("search-input");
    field.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    typeQuery(field, "粗", true);
    expect(getSearchQuery(view().state).search).toBe("");
    field.value = "粗體";
    field.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "粗體" }),
    );
    expect(getSearchQuery(view().state).search).toBe("粗體");
    expect(count()).toBe("1 / 1");
  });

  it("replace one, then replace all in a single undo step with $1 group references", () => {
    openFind(view(), { replace: true });
    expect(panel()!.dataset.replace).toBe("true");
    typeQuery(input("search-input"), "apple");
    typeQuery(input("replace-input"), "pear");
    replaceCurrent(view());
    expect(
      view().state.doc.toString().startsWith("第一段 pear 與 Apple。"),
    ).toBe(true);
    const afterOne = view().state.doc.toString();

    replaceAllMatches(view());
    const doc = view().state.doc.toString();
    expect(doc).not.toMatch(/apple/i);
    expect(doc).toContain("| pear | 1 |");
    expect(doc).toContain("const pear = 1;");
    undo(view());
    expect(view().state.doc.toString()).toBe(afterOne);

    input("search-regex").click();
    typeQuery(input("search-input"), "(A|a)pple");
    typeQuery(input("replace-input"), "[$1]");
    replaceAllMatches(view());
    expect(view().state.doc.toString()).toContain("第一段 pear 與 [A]。");
  });

  it("Cmd+Enter in the replace field replaces all", () => {
    openFind(view(), { replace: true });
    typeQuery(input("search-input"), "apple");
    typeQuery(input("replace-input"), "kiwi");
    key(input("replace-input"), "Enter", { metaKey: true });
    expect(view().state.doc.toString()).not.toMatch(/apple/i);
  });

  it("a hit in a table cell: navigating from the editor focuses that cell and selects the hit", async () => {
    openFind(view());
    typeQuery(input("search-input"), "apple");
    view().focus();
    const target = DOC.indexOf("| apple") + 2;
    while (selected().from !== target) findNextMatch(view());
    // Go round once more from the editor so the cell gets focus.
    findPreviousMatch(view());
    view().focus();
    findNextMatch(view());
    await flush();
    expect(selected()).toMatchObject({ from: target, to: target + 5 });
    expect(getActiveTableCell(view().state)).toMatchObject({ row: 1, col: 0 });
    const cell = view().contentDOM.querySelector<HTMLElement>(
      '[data-testid="table-widget"] [data-row="1"][data-col="0"]',
    );
    expect(cell).not.toBeNull();
    expect(document.activeElement).toBe(
      cell!.querySelector(".k-table-cell-content"),
    );
    expect(document.getSelection()!.toString()).toBe("apple");
    expect(cell!.classList.contains("k-search-cell-current")).toBe(true);
  });

  it("Esc closes the bar and gives focus back to the editor at the hit", () => {
    openFind(view());
    typeQuery(input("search-input"), "Apple");
    input("search-case").click();
    key(input("search-input"), "Escape");
    expect(searchPanelOpen(view().state)).toBe(false);
    expect(panel()).toBeNull();
    expect(view().hasFocus).toBe(true);
    expect(selected().from).toBe(DOC.indexOf("Apple"));
  });

  it("works in source mode", () => {
    app!.editor.setSourceMode(true);
    openFind(view());
    typeQuery(input("search-input"), "apple");
    expect(count()).toBe("1 / 7");
    findNextMatch(view());
    expect(count()).toBe("2 / 7");
  });
});
