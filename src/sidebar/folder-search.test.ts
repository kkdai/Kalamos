import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOLDER_SEARCH_MAX_RESULTS,
  type FolderSearchHit,
  type FolderSearchResults,
  makeSearchSnippet,
  resetMockState,
  searchInFolder,
  seedMockDir,
  seedMockFile,
  setMockDialogHandlers,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  createFolderSearch,
  FOLDER_SEARCH_DEBOUNCE_MS,
  groupHitsByFile,
  relativeDir,
  shortenLead,
  summaryText,
} from "./folder-search";

/** #73 B: folder search. */

const plain = { caseSensitive: false, wholeWord: false, regex: false };

describe("#73 B mock search_in_folder (same rules as Rust)", () => {
  beforeEach(() => {
    resetMockState();
    seedMockDir("/notes");
    seedMockFile("/notes/a.md", "Apple apple\n第二行 APPLE\r\nend");
    seedMockFile("/notes/sub/b.markdown", "cat concat cat_x (cat)");
    seedMockFile("/notes/.hidden/c.md", "apple");
    seedMockFile("/notes/node_modules/x/d.md", "apple");
    seedMockFile("/notes/e.txt", "apple");
  });

  it("case, positions (1-based, UTF-16), files before sub-folders", async () => {
    const r = await searchInFolder("/notes", "apple", plain);
    expect(r.hits.map((h) => [h.path, h.line, h.column, h.length])).toEqual([
      ["/notes/a.md", 1, 1, 5],
      ["/notes/a.md", 1, 7, 5],
      ["/notes/a.md", 2, 5, 5],
    ]);
    expect(r.truncated).toBe(false);
    const exact = await searchInFolder("/notes", "apple", {
      ...plain,
      caseSensitive: true,
    });
    expect(exact.hits).toHaveLength(1);
  });

  it("whole word, regex, invalid regex", async () => {
    const w = await searchInFolder("/notes", "cat", {
      ...plain,
      wholeWord: true,
    });
    expect(w.hits.map((h) => h.column)).toEqual([1, 19]);
    const re = await searchInFolder("/notes", "c.t", { ...plain, regex: true });
    expect(re.hits.length).toBe(4);
    expect((await searchInFolder("/notes", "c.t", plain)).hits).toHaveLength(0);
    await expect(
      searchInFolder("/notes", "a(", { ...plain, regex: true }),
    ).rejects.toMatchObject({ kind: "Parse" });
  });

  it("truncates at the result limit", async () => {
    seedMockFile(
      "/notes/many.md",
      "zz\n".repeat(FOLDER_SEARCH_MAX_RESULTS + 5),
    );
    const r = await searchInFolder("/notes", "zz", plain);
    expect(r.hits).toHaveLength(FOLDER_SEARCH_MAX_RESULTS);
    expect(r.truncated).toBe(true);
  });

  it("snippets keep the hit and do not split surrogate pairs", () => {
    const line = `${"🙂".repeat(80)}關鍵字${"x".repeat(200)}`;
    const start = line.indexOf("關鍵字");
    const { snippet, matchStart, matchEnd } = makeSearchSnippet(
      line,
      start,
      start + 3,
    );
    expect(snippet.slice(matchStart, matchEnd)).toBe("關鍵字");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    // No lone surrogates.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        snippet,
      ),
    ).toBe(false);
    expect(makeSearchSnippet("    - item", 6, 10)).toEqual({
      snippet: "- item",
      matchStart: 2,
      matchEnd: 6,
    });
  });
});

describe("#73 B helpers", () => {
  const hit = (path: string, line: number): FolderSearchHit => ({
    path,
    line,
    column: 1,
    length: 1,
    snippet: "x",
    snippetMatchStart: 0,
    snippetMatchEnd: 1,
  });

  it("groups by file in first-seen order", () => {
    const groups = groupHitsByFile([
      hit("/a.md", 1),
      hit("/b.md", 1),
      hit("/a.md", 3),
    ]);
    expect(groups.map((g) => [g.path, g.hits.length])).toEqual([
      ["/a.md", 2],
      ["/b.md", 1],
    ]);
  });

  it("relativeDir / summaryText / shortenLead", () => {
    expect(relativeDir("/notes", "/notes/a.md")).toBe("");
    expect(relativeDir("/notes/", "/notes/x/y/a.md")).toBe("x/y");
    expect(summaryText({ hits: [], truncated: false, filesSearched: 3 })).toBe(
      "無結果",
    );
    expect(
      summaryText({
        hits: [hit("/a.md", 1), hit("/b.md", 2)],
        truncated: false,
        filesSearched: 2,
      }),
    ).toBe("2 筆結果，2 個檔案");
    expect(
      summaryText({
        hits: [hit("/a.md", 1)],
        truncated: true,
        filesSearched: 2,
      }),
    ).toContain("已截斷");
    expect(shortenLead("short ")).toBe("short ");
    expect(shortenLead("一二三四五六七八九十甲乙丙丁戊")).toBe("…十甲乙丙丁戊");
  });
});

describe("#73 B search view", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const results = (path: string): FolderSearchResults => ({
    hits: [
      {
        path,
        line: 2,
        column: 3,
        length: 2,
        snippet: "ab cd ef",
        snippetMatchStart: 3,
        snippetMatchEnd: 5,
      },
    ],
    truncated: false,
    filesSearched: 1,
  });

  function type(input: HTMLInputElement, value: string, isComposing = false) {
    input.value = value;
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing }),
    );
  }

  it("debounces typing (~250 ms) and highlights the hit; asks for a folder when none is open", async () => {
    vi.useFakeTimers();
    let folder: string | null = null;
    const search = vi.fn(async (root: string) => results(`${root}/a.md`));
    const view = createFolderSearch({
      getFolder: () => folder,
      onOpenHit: () => {},
      search,
    });
    document.body.appendChild(view.element);
    view.refresh();
    const status = view.element.querySelector(
      '[data-testid="folder-search-status"]',
    )!;
    expect(status.textContent).toContain("請先開啟資料夾");

    folder = "/notes";
    view.refresh();
    const input = view.element.querySelector<HTMLInputElement>(
      '[data-testid="folder-search-input"]',
    )!;
    type(input, "c");
    type(input, "cd");
    await vi.advanceTimersByTimeAsync(FOLDER_SEARCH_DEBOUNCE_MS - 10);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("/notes", "cd", plain);
    expect(view.element.querySelector("mark")!.textContent).toBe("cd");
    expect(status.textContent).toBe("1 筆結果，1 個檔案");
  });

  it("no search while composing; searches after compositionend", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (root: string) => results(`${root}/a.md`));
    const view = createFolderSearch({
      getFolder: () => "/n",
      onOpenHit: () => {},
      search,
    });
    const input = view.element.querySelector<HTMLInputElement>(
      '[data-testid="folder-search-input"]',
    )!;
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    type(input, "搜", true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(search).not.toHaveBeenCalled();
    input.value = "搜尋";
    input.dispatchEvent(
      new CompositionEvent("compositionend", { data: "搜尋" }),
    );
    await vi.advanceTimersByTimeAsync(FOLDER_SEARCH_DEBOUNCE_MS + 10);
    expect(search).toHaveBeenCalledWith("/n", "搜尋", plain);
  });

  it("an older, slower search never overwrites a newer result", async () => {
    const pending: Array<(r: FolderSearchResults) => void> = [];
    const search = vi.fn(
      (_root: string, _q: string) =>
        new Promise<FolderSearchResults>((resolve) => pending.push(resolve)),
    );
    const view = createFolderSearch({
      getFolder: () => "/n",
      onOpenHit: () => {},
      search,
    });
    const input = view.element.querySelector<HTMLInputElement>(
      '[data-testid="folder-search-input"]',
    )!;
    input.value = "old";
    const first = view.runNow();
    input.value = "new";
    const second = view.runNow();
    pending[1](results("/n/new.md"));
    await second;
    pending[0](results("/n/old.md"));
    await first;
    const groups = [
      ...view.element.querySelectorAll<HTMLElement>(
        '[data-testid="folder-search-group"]',
      ),
    ];
    expect(groups.map((g) => g.dataset.path)).toEqual(["/n/new.md"]);
  });

  it("groups collapse; clicking a hit reports it; invalid regex shows a hint", async () => {
    const opened: FolderSearchHit[] = [];
    const search = vi.fn(
      async (_root: string, q: string, o: { regex: boolean }) => {
        if (o.regex && q === "(") throw { kind: "Parse", message: "bad" };
        return results("/n/a.md");
      },
    );
    const view = createFolderSearch({
      getFolder: () => "/n",
      onOpenHit: (h) => void opened.push(h),
      search,
    });
    const input = view.element.querySelector<HTMLInputElement>(
      '[data-testid="folder-search-input"]',
    )!;
    input.value = "cd";
    await view.runNow();
    const group = view.element.querySelector<HTMLElement>(
      '[data-testid="folder-search-group"]',
    )!;
    view.element
      .querySelector<HTMLElement>('[data-testid="folder-search-file"]')!
      .click();
    expect(group.dataset.collapsed).toBe("true");
    view.element
      .querySelector<HTMLElement>('[data-testid="folder-search-file"]')!
      .click();
    expect(group.dataset.collapsed).toBe("false");
    view.element
      .querySelector<HTMLElement>('[data-testid="folder-search-hit"]')!
      .click();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ path: "/n/a.md", line: 2 });

    view.element
      .querySelector<HTMLElement>('[data-testid="folder-search-regex"]')!
      .click();
    input.value = "(";
    await view.runNow();
    expect(
      view.element.querySelector('[data-testid="folder-search-status"]')!
        .textContent,
    ).toBe("正規表示式無效");
  });
});

describe("#73 B in the app", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    document.body.innerHTML = `
      <aside id="sidebar" data-testid="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status"></div>`;
    seedMockDir("/notes");
    seedMockFile("/notes/a.md", "# A\n\n第一段 needle 在這裡\n");
    seedMockFile(
      "/notes/sub/b.md",
      "| 名稱 | 數量 |\n| --- | --- |\n| needle | 1 |\n",
    );
    app = createKalamosApp(document);
    await app.init();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  const sidebar = () =>
    document.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      '[data-testid="folder-search-input"]',
    )!;
  const cmdShiftF = () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

  it("Cmd+Shift+F shows the search tab (asks for a folder if none) and focuses the field", async () => {
    cmdShiftF();
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    expect(sidebar().dataset.visible).toBe("true");
    expect(
      document
        .querySelector('[data-testid="sidebar-tab-search"]')!
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="folder-search-status"]')!
        .textContent,
    ).toContain("請先開啟資料夾");
  });

  it("clicking a hit opens the file and selects the hit (also inside a table cell)", async () => {
    await app!.openFolder("/notes");
    cmdShiftF();
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    input().value = "needle";
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="folder-search-hit"]'),
      ).toHaveLength(2),
    );

    const hits = document.querySelectorAll<HTMLElement>(
      '[data-testid="folder-search-hit"]',
    );
    hits[0].click();
    await vi.waitFor(() =>
      expect(app!.editor.getContent()).toContain("第一段"),
    );
    const view = app!.editor.view;
    await vi.waitFor(() => {
      const sel = view.state.selection.main;
      expect(view.state.sliceDoc(sel.from, sel.to)).toBe("needle");
    });

    hits[1].click();
    await vi.waitFor(() =>
      expect(app!.editor.getContent()).toContain("| needle |"),
    );
    await vi.waitFor(() => {
      const sel = view.state.selection.main;
      expect(view.state.sliceDoc(sel.from, sel.to)).toBe("needle");
      expect(
        (document.activeElement as HTMLElement).classList.contains(
          "k-table-cell-content",
        ),
      ).toBe(true);
    });
  });

  it("#81 B unsaved changes: no prompt — the hit opens in a new tab and the edited document stays", async () => {
    await app!.openFolder("/notes");
    seedMockFile("/notes/c.md", "other needle");
    let asked = 0;
    setMockDialogHandlers({ ask: () => (asked++, false), save: () => null });
    await app!.sidebar.openSearch();
    input().value = "other";
    await app!.sidebar.folderSearch.runNow();
    const view = app!.editor.view;
    view.dispatch({ changes: { from: 0, insert: "dirty " } });
    document
      .querySelector<HTMLElement>('[data-testid="folder-search-hit"]')!
      .click();
    await vi.waitFor(() => expect(app!.getCurrentPath()).toBe("/notes/c.md"));
    expect(asked).toBe(0);
    expect(app!.getTabs()).toHaveLength(2);
    app!.cycleTab(1);
    expect(app!.editor.getContent().startsWith("dirty ")).toBe(true);
  });
});
