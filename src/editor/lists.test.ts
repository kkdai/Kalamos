import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState, seedMockFile } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  collectDocumentHeadings,
  getLastCopiedBookmark,
  handleListEnter,
  indentListItem,
  outdentListItem,
  parseRelativeMarkdownLink,
  resolveRelativeMarkdownPath,
  slugifyHeadingText,
} from "./lists";

function setupDom(): void {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message">偵測到上次未儲存的內容，是否還原？</span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn">還原</button>
          <button type="button" id="recovery-discard-btn">捨棄</button>
        </div>
      </div>
      <main id="editor-container" aria-label="Markdown Editor"></main>
      <div id="status" data-testid="status" role="status" aria-live="polite"></div>
    </div>
  `;
}

describe("Lists & Task Lists (ED-04) and Links & Bookmarks (ED-05)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.restoreAllMocks();
  });

  it("Enter continues unordered, ordered (auto-incrementing), and task lists, and exits on empty item", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    // 1. Unordered list continuation & exit on empty item
    app.editor.setContent("- 第一項");
    app.editor.setCursor(view.state.doc.length);
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- 第一項\n- ");

    // Press Enter again on empty `- ` -> exits list
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- 第一項\n");

    // 2. Ordered list auto-increment & exit on empty item
    app.editor.setContent("1. First");
    app.editor.setCursor(view.state.doc.length);
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("1. First\n2. ");

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "Second" },
      selection: { anchor: view.state.doc.length + 6 },
    });
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("1. First\n2. Second\n3. ");

    // Press Enter on empty `3. ` -> exits list
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("1. First\n2. Second\n");

    // 3. Task list continues as `- [ ] ` and exits on empty item
    app.editor.setContent("- [x] 已完成項目");
    app.editor.setCursor(view.state.doc.length);
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- [x] 已完成項目\n- [ ] ");

    // Press Enter on empty `- [ ] ` -> exits list
    expect(handleListEnter(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- [x] 已完成項目\n");
  });

  it("Tab and Shift+Tab indent/outdent list items aligned to parent item content column", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    // Unordered parent (`- ` width 2) -> child indents by 2 spaces
    app.editor.setContent("- parent\n- child");
    app.editor.setCursor(app.editor.getContent().indexOf("child"));
    expect(indentListItem(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- parent\n  - child");

    expect(outdentListItem(view)).toBe(true);
    expect(app.editor.getContent()).toBe("- parent\n- child");

    // Ordered parent (`1. ` width 3) -> child indents by 3 spaces
    app.editor.setContent("1. parent\n- child");
    app.editor.setCursor(app.editor.getContent().indexOf("child"));
    expect(indentListItem(view)).toBe(true);
    expect(app.editor.getContent()).toBe("1. parent\n   - child");

    expect(outdentListItem(view)).toBe(true);
    expect(app.editor.getContent()).toBe("1. parent\n- child");
  });

  it("toggles ordered (Cmd+Shift+[), bullet (Cmd+Shift+]), and task lists (Cmd+Shift+X)", async () => {
    app = createKalamosApp(document);
    await app.init();

    app.editor.setContent("待辦事項");
    app.editor.setCursor(2);

    // Cmd+Shift+[ -> Ordered list
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "[",
        code: "BracketLeft",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("1. 待辦事項");

    // Cmd+Shift+] -> Bullet list
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("- 待辦事項");

    // Cmd+Shift+X -> Task list
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("- [ ] 待辦事項");

    // Pressing Cmd+Shift+X again toggles off back to plain line
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("待辦事項");
  });

  it("renders bullet dots only for non-task bullets, hides task `-` with .k-mark-hidden, and supports undoable checkbox clicks via posAtDOM", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const doc = [
      "Header line",
      "- 無序項目",
      "1. 有序項目",
      "- [ ] 未勾選任務",
      "- [x] 已勾選任務",
    ].join("\n");
    app.editor.setContent(doc);
    // Keep cursor on line 1 ("Header line") so all list lines are inactive
    app.editor.setCursor(0);

    // Only the 1 normal bullet item has .k-bullet-marker; the 2 task items hide `-` instead
    const bullets = view.contentDOM.querySelectorAll(".k-bullet-marker");
    expect(bullets).toHaveLength(1);
    expect(bullets[0].textContent).toBe("•");
    expect(bullets[0].classList.contains("k-list-marker")).toBe(true);

    const hiddenMarks = Array.from(
      view.contentDOM.querySelectorAll(".k-mark-hidden"),
    ).map((el) => el.textContent);
    expect(hiddenMarks).toContain("- ");

    const markers = Array.from(
      view.contentDOM.querySelectorAll(".k-list-marker"),
    ).map((el) => el.textContent);
    expect(markers).toContain("1.");

    const checkboxes = view.contentDOM.querySelectorAll<HTMLInputElement>(
      "input.k-task-checkbox",
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);

    // Simulate IME composition inserting text before the task items (shifting document offsets
    // while decorations are only mapped and not rebuilt), then click checkbox[0]
    view.contentDOM.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    view.dispatch({
      changes: { from: 0, insert: "前置組字內容 " },
      selection: { anchor: 0, head: 0 },
    });

    checkboxes[0].click();
    expect(app.editor.getContent()).toContain("- [x] 未勾選任務");

    view.contentDOM.dispatchEvent(
      new Event("compositionend", { bubbles: true }),
    );

    // Undo restores `[ ]`
    expect(undo(view)).toBe(true);
    expect(app.editor.getContent()).toContain("- [ ] 未勾選任務");
  });

  it("computes GitHub-compatible heading slugs (keeps _, each space to -, CJK kept, duplicates -1/-2) and parses ATX & Setext via syntaxTree while ignoring indented code", async () => {
    expect(slugifyHeadingText("Hello_World")).toBe("hello_world");
    expect(slugifyHeadingText("a  b")).toBe("a--b");
    expect(slugifyHeadingText("C++ 與 Rust!")).toBe("c-與-rust");
    expect(slugifyHeadingText("中文 標題（二）")).toBe("中文-標題二");
    expect(slugifyHeadingText("一、行內樣式與符號隱藏（無殘留空白）")).toBe(
      "一行內樣式與符號隱藏無殘留空白",
    );

    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "# 簡介 Intro",
      "",
      "Setext 大標題",
      "=============",
      "",
      "Setext 次標題",
      "-------------",
      "",
      "    # 縮排程式碼區塊內的井號不是標題",
      "",
      "## **重複**標題",
      "",
      "## 重複標題",
      "",
      "### 重複標題",
    ].join("\n");
    app.editor.setContent(doc);

    const headings = collectDocumentHeadings(app.editor.view.state);
    expect(
      headings.map((h) => ({ level: h.level, text: h.text, slug: h.slug })),
    ).toEqual([
      { level: 1, text: "簡介 Intro", slug: "簡介-intro" },
      { level: 1, text: "Setext 大標題", slug: "setext-大標題" },
      { level: 2, text: "Setext 次標題", slug: "setext-次標題" },
      { level: 2, text: "重複標題", slug: "重複標題" },
      { level: 2, text: "重複標題", slug: "重複標題-1" },
      { level: 3, text: "重複標題", slug: "重複標題-2" },
    ]);
  });

  it("jumps to heading on Cmd+Click #slug and copies [標題](#slug) on Cmd+Shift+C", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const doc = [
      "[跳到第二個重複標題](#重複標題-1)",
      "",
      "# 重複標題",
      "段落 A",
      "## 重複標題",
      "段落 B",
    ].join("\n");
    app.editor.setContent(doc);

    // Place cursor on the link and Cmd+Click
    app.editor.setCursor(2);
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );

    const targetHeadingLine = view.state.doc.lineAt(
      view.state.selection.main.head,
    );
    expect(targetHeadingLine.text).toBe("## 重複標題");
    expect(targetHeadingLine.number).toBe(5);

    // Press Cmd+Shift+C on line 5 (`## 重複標題`, which has slug `重複標題-1`)
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "C",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    expect(getLastCopiedBookmark()).toBe("[重複標題](#重複標題-1)");
    expect(writeTextMock).toHaveBeenCalledWith("[重複標題](#重複標題-1)");
  });

  it("parseRelativeMarkdownLink and resolveRelativeMarkdownPath handle my%20note.md, <my note.md>, notes/a.md?x=1#標題, ../up.md, and malformed %E0 encoding", () => {
    expect(parseRelativeMarkdownLink("my%20note.md")).toEqual({
      pathPart: "my note.md",
      slugPart: null,
    });
    expect(parseRelativeMarkdownLink("<my note.md>")).toEqual({
      pathPart: "my note.md",
      slugPart: null,
    });
    expect(parseRelativeMarkdownLink("notes/a.md?x=1#標題")).toEqual({
      pathPart: "notes/a.md",
      slugPart: "標題",
    });
    expect(parseRelativeMarkdownLink("../up.md")).toEqual({
      pathPart: "../up.md",
      slugPart: null,
    });
    expect(parseRelativeMarkdownLink("bad%E0.md")).toEqual({
      pathPart: "bad%E0.md",
      slugPart: null,
    });

    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/docs/curr.md", "my%20note.md"),
    ).toBe("/tmp/kalamos/docs/my note.md");
    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/docs/curr.md", "<my note.md>"),
    ).toBe("/tmp/kalamos/docs/my note.md");
    expect(
      resolveRelativeMarkdownPath(
        "/tmp/kalamos/docs/curr.md",
        "notes/a.md?x=1#標題",
      ),
    ).toBe("/tmp/kalamos/docs/notes/a.md");
    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/docs/curr.md", "../up.md"),
    ).toBe("/tmp/kalamos/up.md");
    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/docs/curr.md", "bad%E0.md"),
    ).toBe("/tmp/kalamos/docs/bad%E0.md");
  });

  it("resolves relative .md paths (including %20 encoding, <...> angle brackets, and ?query), opens them in app on Cmd+Click, and warns if untitled", async () => {
    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/notes/a.md", "./b.md"),
    ).toBe("/tmp/kalamos/notes/b.md");
    expect(
      resolveRelativeMarkdownPath("/tmp/kalamos/notes/sub/a.md", "../c.md"),
    ).toBe("/tmp/kalamos/notes/c.md");
    expect(
      resolveRelativeMarkdownPath(
        "/tmp/kalamos/notes/a.md",
        "my%20note.md?ver=1#sec",
      ),
    ).toBe("/tmp/kalamos/notes/my note.md");
    expect(
      resolveRelativeMarkdownPath(
        "/tmp/kalamos/notes/a.md",
        "<my note.md?ver=1>",
      ),
    ).toBe("/tmp/kalamos/notes/my note.md");

    expect(parseRelativeMarkdownLink("my%20note.md?foo=bar#介紹")).toEqual({
      pathPart: "my note.md",
      slugPart: "介紹",
    });
    expect(parseRelativeMarkdownLink("<my note.md>")).toEqual({
      pathPart: "my note.md",
      slugPart: null,
    });

    seedMockFile(
      "/tmp/kalamos/notes/index.md",
      "[百分比編碼](./sub/my%20note.md?draft=1#安裝步驟)\n[角括號](<./sub/my note.md#總覽>)\n",
    );
    seedMockFile(
      "/tmp/kalamos/notes/sub/my note.md",
      "# 總覽\n\n說明\n\n## 安裝步驟\n\n步驟內容",
    );

    app = createKalamosApp(document);
    await app.init();

    // 1. Untitled document: Cmd+Click on relative link prompts user to save first
    app.editor.setContent("[未命名相對連結](./sub/my%20note.md)");
    app.editor.setCursor(2);
    app.editor.view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(app.getStatusText()).toContain("請先儲存");

    // 2. Named document: Cmd+Click on `my%20note.md?draft=1#安裝步驟` opens `my note.md` and jumps to `#安裝步驟`
    await app.openDocument("/tmp/kalamos/notes/index.md");
    app.editor.setCursor(2);
    app.editor.view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getCurrentPath()).toBe("/tmp/kalamos/notes/sub/my note.md");
    const stepLine = app.editor.view.state.doc.lineAt(
      app.editor.view.state.selection.main.head,
    );
    expect(stepLine.text).toBe("## 安裝步驟");

    // 3. Named document: Cmd+Click on `<./sub/my note.md#總覽>` opens `my note.md` and jumps to `#總覽`
    await app.openDocument("/tmp/kalamos/notes/index.md");
    const angleIdx = app.editor.getContent().indexOf("角括號");
    app.editor.setCursor(angleIdx + 1);
    app.editor.view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getCurrentPath()).toBe("/tmp/kalamos/notes/sub/my note.md");
    const overviewLine = app.editor.view.state.doc.lineAt(
      app.editor.view.state.selection.main.head,
    );
    expect(overviewLine.text).toBe("# 總覽");
  });
});
