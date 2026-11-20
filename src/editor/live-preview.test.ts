import { forceParsing, syntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, resetMockState, setSettings } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  buildLivePreviewDecorations,
  collectLivePreviewSpecs,
  isAllowedExternalUrl,
  livePreviewPlugin,
} from "./live-preview";

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

describe("Live Preview (ED-01), Source Mode (ED-02), Shortcuts (ED-03) & IME", () => {
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

  it("applies .k-mark-hidden and content classes when cursor is outside, and .k-mark when cursor enters", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "Plain line",
      "**粗體** *斜體* `code` ~~刪除~~ [文字](https://example.com)",
      "# H1",
      "## H2",
      "### H3",
      "#### H4",
      "##### H5",
      "###### H6",
    ].join("\n");

    app.editor.setContent(doc);
    // Move cursor to line 1 ("Plain line", pos 0) -> outside all formatted nodes
    app.editor.setCursor(0);

    const specsOutside = collectLivePreviewSpecs(app.editor.view.state);

    // Check inline nodes on line 2 when cursor is at pos 0
    const strongIdx = doc.indexOf("**粗體**");
    expect(specsOutside).toContainEqual({
      from: strongIdx,
      to: strongIdx + 2,
      className: "k-mark-hidden",
    });
    expect(specsOutside).toContainEqual({
      from: strongIdx + 2,
      to: strongIdx + 4,
      className: "k-strong",
    });
    expect(specsOutside).toContainEqual({
      from: strongIdx + 4,
      to: strongIdx + 6,
      className: "k-mark-hidden",
    });

    const emIdx = doc.indexOf("*斜體*");
    expect(specsOutside).toContainEqual({
      from: emIdx,
      to: emIdx + 1,
      className: "k-mark-hidden",
    });
    expect(specsOutside).toContainEqual({
      from: emIdx + 1,
      to: emIdx + 3,
      className: "k-em",
    });
    expect(specsOutside).toContainEqual({
      from: emIdx + 3,
      to: emIdx + 4,
      className: "k-mark-hidden",
    });

    const codeIdx = doc.indexOf("`code`");
    expect(specsOutside).toContainEqual({
      from: codeIdx,
      to: codeIdx + 1,
      className: "k-mark-hidden",
    });
    expect(specsOutside).toContainEqual({
      from: codeIdx + 1,
      to: codeIdx + 5,
      className: "k-code",
    });
    expect(specsOutside).toContainEqual({
      from: codeIdx + 5,
      to: codeIdx + 6,
      className: "k-mark-hidden",
    });

    const strikeIdx = doc.indexOf("~~刪除~~");
    expect(specsOutside).toContainEqual({
      from: strikeIdx,
      to: strikeIdx + 2,
      className: "k-mark-hidden",
    });
    expect(specsOutside).toContainEqual({
      from: strikeIdx + 2,
      to: strikeIdx + 4,
      className: "k-strike",
    });
    expect(specsOutside).toContainEqual({
      from: strikeIdx + 4,
      to: strikeIdx + 6,
      className: "k-mark-hidden",
    });

    const linkIdx = doc.indexOf("[文字](https://example.com)");
    expect(specsOutside).toContainEqual({
      from: linkIdx,
      to: linkIdx + 1,
      className: "k-mark-hidden",
    });
    expect(specsOutside).toContainEqual({
      from: linkIdx + 1,
      to: linkIdx + 3,
      className: "k-link",
    });
    expect(specsOutside).toContainEqual({
      from: linkIdx + 3,
      to: linkIdx + "[文字](https://example.com)".length,
      className: "k-mark-hidden",
    });

    // Check headings H1..H6 when cursor is outside
    for (let level = 1; level <= 6; level++) {
      const hashes = "#".repeat(level);
      const headingStr = `${hashes} H${level}`;
      const hIdx = doc.indexOf(headingStr);
      expect(specsOutside).toContainEqual({
        from: hIdx,
        to: hIdx + level + 1,
        className: "k-mark-hidden",
      });
      expect(specsOutside).toContainEqual({
        from: hIdx + level + 1,
        to: hIdx + headingStr.length,
        className: `k-h${level}`,
      });
    }

    // Verify DOM classes rendered by ViewPlugin
    const contentDom = app.editor.view.contentDOM;
    expect(contentDom.querySelector(".k-strong")?.textContent).toBe("粗體");
    expect(contentDom.querySelector(".k-em")?.textContent).toBe("斜體");
    expect(contentDom.querySelector(".k-code")?.textContent).toBe("code");
    expect(contentDom.querySelector(".k-strike")?.textContent).toBe("刪除");
    expect(contentDom.querySelector(".k-link")?.textContent).toBe("文字");
    expect(contentDom.querySelector(".k-h1")?.textContent).toBe("H1");
    expect(contentDom.querySelector(".k-h6")?.textContent).toBe("H6");

    // Now move cursor inside **粗體** -> syntax markers become .k-mark instead of .k-mark-hidden
    app.editor.setCursor(strongIdx + 3);
    const specsInsideStrong = collectLivePreviewSpecs(app.editor.view.state);
    expect(specsInsideStrong).toContainEqual({
      from: strongIdx,
      to: strongIdx + 2,
      className: "k-mark",
    });
    expect(specsInsideStrong).toContainEqual({
      from: strongIdx + 4,
      to: strongIdx + 6,
      className: "k-mark",
    });

    // Cursor on the `#` itself -> heading marker becomes .k-mark
    const h1Idx = doc.indexOf("# H1");
    app.editor.setCursor(h1Idx + 1);
    const specsInsideH1 = collectLivePreviewSpecs(app.editor.view.state);
    expect(specsInsideH1).toContainEqual({
      from: h1Idx,
      to: h1Idx + 2,
      className: "k-mark",
    });

    // #49: cursor in the heading text (not on `#`) keeps the marker hidden
    app.editor.setCursor(h1Idx + 3);
    expect(collectLivePreviewSpecs(app.editor.view.state)).toContainEqual({
      from: h1Idx,
      to: h1Idx + 2,
      className: "k-mark-hidden",
    });

    // Document string is completely untouched by decorations
    expect(app.editor.getContent()).toBe(doc);
    expect(app.editor.view.state.doc.toString()).toBe(doc);
  });

  it("parses and decorates CJK adjacent bold `中文**粗體**中文` as StrongEmphasis", async () => {
    app = createKalamosApp(document);
    await app.init();

    const cjkDoc = "中文**粗體**中文\n第二行";
    app.editor.setContent(cjkDoc);
    // Move cursor to line 2 (outside `中文**粗體**中文`)
    app.editor.setCursor(cjkDoc.length);

    const specs = collectLivePreviewSpecs(app.editor.view.state);
    expect(specs).toEqual([
      { from: 2, to: 4, className: "k-mark-hidden" },
      { from: 4, to: 6, className: "k-strong" },
      { from: 6, to: 8, className: "k-mark-hidden" },
    ]);
    expect(
      app.editor.view.contentDOM.querySelector(".k-strong")?.textContent,
    ).toBe("粗體");
  });

  it("parses bold whose inner side is full-width punctuation next to CJK (`中文**「粗體」**中文`) [#22]", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = "中文**「粗體」**中文\n第二行";
    app.editor.setContent(doc);
    app.editor.setCursor(doc.length);
    expect(collectLivePreviewSpecs(app.editor.view.state)).toEqual([
      { from: 2, to: 4, className: "k-mark-hidden" },
      { from: 4, to: 8, className: "k-strong" },
      { from: 8, to: 10, className: "k-mark-hidden" },
    ]);
    expect(app.editor.view.contentDOM.querySelector(".k-strong")?.textContent).toBe("「粗體」");
    // Parse/render only: the text is untouched.
    expect(app.editor.getContent()).toBe(doc);
  });

  it("parses bold ending in full-width punctuation before CJK (`中文**粗體。**中文`) [#22]", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = "中文**粗體。**中文\n第二行";
    app.editor.setContent(doc);
    app.editor.setCursor(doc.length);
    expect(collectLivePreviewSpecs(app.editor.view.state)).toEqual([
      { from: 2, to: 4, className: "k-mark-hidden" },
      { from: 4, to: 7, className: "k-strong" },
      { from: 7, to: 9, className: "k-mark-hidden" },
    ]);
    expect(app.editor.view.contentDOM.querySelector(".k-strong")?.textContent).toBe("粗體。");
    expect(app.editor.getContent()).toBe(doc);
  });

  it("rebuilds decorations in < 16ms on a 10,000-line document by only iterating visibleRanges", async () => {
    app = createKalamosApp(document);
    await app.init();

    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(
        `## Section ${i} — **粗體 ${i}** with *斜體* and \`code_${i}\` plus [link](https://example.com/${i})`,
      );
    }
    const largeDoc = lines.join("\n");
    app.editor.setContent(largeDoc);

    const midLine = app.editor.view.state.doc.line(5000);
    app.editor.setCursor(midLine.from + 5);

    const start = performance.now();
    buildLivePreviewDecorations(app.editor.view);
    const elapsedMs = performance.now() - start;

    // Target < 16ms (< 50ms allowed in jsdom due to simulated DOM/viewport overhead)
    expect(elapsedMs).toBeLessThan(16);
  });

  it("rebuilds decorations when background parser advances syntaxTree without docChanged or selectionSet", async () => {
    app = createKalamosApp(document);
    await app.init();

    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`Line ${i} with **bold_${i}** and *italic_${i}*`);
    }
    const largeDoc = lines.join("\n");
    app.editor.setContent(largeDoc);

    const { view } = app.editor;
    const pluginInstance = view.plugin(livePreviewPlugin)!;
    expect(pluginInstance).not.toBeNull();

    // Expand visibleRanges to the tail of the document (initially unparsed by sync init budget)
    const tailFrom = largeDoc.length - 200;
    const tailTo = largeDoc.length;
    vi.spyOn(view, "visibleRanges", "get").mockReturnValue([
      { from: tailFrom, to: tailTo },
    ]);

    // Before forceParsing reaches the end of the 5,000-line doc, clear decorations to simulate pre-parse state
    const treeBefore = syntaxTree(view.state);
    pluginInstance.decorations = buildLivePreviewDecorations(view);

    // Advance background parser to the end of the document; this dispatches a state update
    // where docChanged=false and selectionSet=false, only syntaxTree changes.
    const parsedAll = forceParsing(view, tailTo, 1000);
    expect(parsedAll).toBe(true);
    expect(syntaxTree(view.state)).not.toBe(treeBefore);

    // Verify plugin rebuilt decorations for the newly parsed tail range
    let count = 0;
    pluginInstance.decorations.between(tailFrom, tailTo, () => {
      count++;
    });
    expect(count).toBeGreaterThan(0);
  });

  it("Cmd+Click only opens http:, https:, mailto: links and ignores anchors, relative .md, or other schemes", async () => {
    app = createKalamosApp(document);
    await app.init();

    expect(isAllowedExternalUrl("https://example.com/path")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com")).toBe(true);
    expect(isAllowedExternalUrl("mailto:user@example.com")).toBe(true);
    expect(isAllowedExternalUrl("#section-1")).toBe(false);
    expect(isAllowedExternalUrl("./other.md")).toBe(false);
    expect(isAllowedExternalUrl("notes/doc.md")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const doc = [
      "[HTTPS](https://example.com)",
      "[Mail](mailto:test@example.com)",
      "[Anchor](#heading)",
      "[Rel](./note.md)",
      "[JS](javascript:alert(1))",
    ].join("\n");
    app.editor.setContent(doc);

    const { view } = app.editor;

    // 1. Normal click (without metaKey/ctrlKey) on HTTPS link -> does not open
    app.editor.setCursor(doc.indexOf("HTTPS") + 1);
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: false, ctrlKey: false }),
    );
    expect(openSpy).not.toHaveBeenCalled();

    // 2. Cmd+Click on HTTPS link -> opens URL
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenLastCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );

    // 3. Cmd+Click on mailto: link -> opens URL
    app.editor.setCursor(doc.indexOf("Mail") + 1);
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenLastCalledWith(
      "mailto:test@example.com",
      "_blank",
      "noopener,noreferrer",
    );

    // 4. Cmd+Click on #anchor, ./note.md, javascript: -> ignored
    for (const label of ["Anchor", "Rel", "JS"]) {
      app.editor.setCursor(doc.indexOf(label) + 1);
      view.contentDOM.dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true }),
      );
    }
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("does not recompute decorations during IME composition and updates after compositionend", async () => {
    app = createKalamosApp(document);
    await app.init();

    const { view } = app.editor;
    app.editor.setContent("第一行\n");
    app.editor.setCursor(view.state.doc.length);

    // Start IME composition
    view.contentDOM.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // Insert markdown syntax and move cursor away while composing
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "**組字中**" },
      selection: { anchor: 0, head: 0 },
    });

    // Because we are composing, decorations must NOT have been recalculated yet
    expect(view.contentDOM.querySelector(".k-strong")).toBeNull();

    // End IME composition
    view.contentDOM.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await Promise.resolve();

    expect(view.contentDOM.querySelector(".k-strong")?.textContent).toBe("組字中");
  });

  it("toggles Source Mode via Cmd+/ preserving content & cursor and saving settings.sourceMode", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = "段落 **粗體** 測試\n第二行游標位置";
    app.editor.setContent(doc);
    const cursorPos = doc.indexOf("游標位置");
    app.editor.setCursor(cursorPos);

    expect(app.editor.isSourceMode()).toBe(false);
    expect(
      app.editor.view.contentDOM.querySelector(".k-strong")?.textContent,
    ).toBe("粗體");

    // Press Cmd+/ to enter source mode
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true }),
    );
    await Promise.resolve();

    expect(app.editor.isSourceMode()).toBe(true);
    expect(app.editor.getContent()).toBe(doc);
    expect(app.editor.view.state.selection.main.head).toBe(cursorPos);
    expect(app.editor.view.contentDOM.querySelector(".k-strong")).toBeNull();
    expect(app.editor.view.contentDOM.querySelector(".k-mark-hidden")).toBeNull();
    expect((await getSettings()).sourceMode).toBe(true);

    // Press Cmd+/ again to return to live preview
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true }),
    );
    await Promise.resolve();

    expect(app.editor.isSourceMode()).toBe(false);
    expect(app.editor.getContent()).toBe(doc);
    expect(app.editor.view.state.selection.main.head).toBe(cursorPos);
    expect(
      app.editor.view.contentDOM.querySelector(".k-strong")?.textContent,
    ).toBe("粗體");
    expect((await getSettings()).sourceMode).toBe(false);
  });

  it("toggles inline formatting with Cmd+B, Cmd+I, Cmd+Shift+`, Cmd+K (with selection and empty selection)", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    // 1. Cmd+B on Chinese selection toggle ON and OFF
    app.editor.setContent("中文粗體中文");
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文**粗體**中文");
    expect(view.state.selection.main.from).toBe(4);
    expect(view.state.selection.main.to).toBe(6);

    // Toggle OFF
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文粗體中文");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(4);

    // 2. Cmd+I on selection toggle ON and OFF
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文*粗體*中文");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文粗體中文");

    // 3. Cmd+Shift+` on selection toggle ON and OFF
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "`",
        code: "Backquote",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("中文`粗體`中文");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "`",
        code: "Backquote",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("中文粗體中文");

    // 4. Cmd+K on selection toggle ON and OFF
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文[粗體]()中文");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("中文粗體中文");

    // 5. Empty selection inserts paired markers and places cursor in the middle
    app.editor.setContent("");
    app.editor.setCursor(0);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("****");
    expect(view.state.selection.main.head).toBe(2);

    app.editor.setContent("");
    app.editor.setCursor(0);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("**");
    expect(view.state.selection.main.head).toBe(1);

    app.editor.setContent("");
    app.editor.setCursor(0);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "`",
        code: "Backquote",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(app.editor.getContent()).toBe("``");
    expect(view.state.selection.main.head).toBe(1);

    app.editor.setContent("");
    app.editor.setCursor(0);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    expect(app.editor.getContent()).toBe("[]()");
    expect(view.state.selection.main.head).toBe(1);
  });

  it("exposes window.__kalamos QA API, data-testid='editor', and applies settings.theme to <html>", async () => {
    await setSettings({
      theme: "melan",
      lastFolder: null,
      sidebarVisible: false,
      sidebarTab: "tree",
      sourceMode: false,
    });

    app = createKalamosApp(document);
    await app.init();

    expect(document.documentElement.getAttribute("data-theme")).toBe("melan");

    await setSettings({
      theme: "system",
      lastFolder: null,
      sidebarVisible: false,
      sidebarTab: "tree",
      sourceMode: false,
    });
    await app.init();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    const editorRoot = document.querySelector('[data-testid="editor"]');
    expect(editorRoot).not.toBeNull();

    expect(window.__kalamos).toBeDefined();
    app.editor.setContent("# Test QA API");
    expect(window.__kalamos!.getDoc()).toBe("# Test QA API");
    window.__kalamos!.setCursor(5);
    expect(app.editor.view.state.selection.main.head).toBe(5);
    expect(window.__kalamos!.isSourceMode()).toBe(false);
  });
});
