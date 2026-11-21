import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  triggerMockOpenFiles,
} from "./ipc";
import { createKalamosApp, openWithStatusMessage, type KalamosApp } from "./main";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" data-visible="false">
        <button type="button" id="recovery-restore-btn">還原</button>
        <button type="button" id="recovery-discard-btn">捨棄</button>
      </div>
      <main id="editor-container"></main>
      <div id="status" data-testid="status"></div>
    </div>
  `;
}

function userTypeText(app: KalamosApp, text: string): void {
  const { view } = app.editor;
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe("#67 open with Kalamos (Finder / Dock / open -a)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockState();
    setupDom();
    seedMockFile("/tmp/kalamos-test/a.md", "# A\n");
    seedMockFile("/tmp/kalamos-test/b.md", "# B\n");
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.useRealTimers();
  });

  it("cold launch: a file queued before the frontend is ready opens once init finishes", async () => {
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    app = createKalamosApp(document);
    expect(app.getCurrentPath()).toBeNull();
    await app.init();
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
    expect(app.editor.getContent()).toBe("# A\n");
    expect(app.editor.isDirty()).toBe(false);
  });

  it("app already running: an opened event switches the current window to that file", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/b.md"] });
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/b.md");
    expect(app.editor.getContent()).toBe("# B\n");
  });

  it("several files: opens the first and reports the rest in the status bar", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({
      paths: ["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/b.md"],
    });
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
    expect(app.getStatusText()).toContain("另有 1 個檔案未開啟");
  });

  it("refused files only: keeps the current document and shows an error", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({ rejected: ["notes.txt"] });
    expect(app.getCurrentPath()).toBeNull();
    expect(app.getStatusText()).toContain("無法開啟：notes.txt");
    expect(document.getElementById("status")!.dataset.error).toBe("true");
  });

  it("unsaved untitled changes: asks first, and cancelling keeps the text", async () => {
    const ask = vi.fn(() => false);
    setMockDialogHandlers({ ask });
    app = createKalamosApp(document);
    await app.init();
    userTypeText(app, "還沒存檔的草稿");

    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.getContent()).toBe("還沒存檔的草稿");

    ask.mockImplementation(() => true);
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
  });

  it("unsaved changes on cold launch: the queued file still goes through the prompt", async () => {
    const ask = vi.fn(() => false);
    setMockDialogHandlers({ ask });
    app = createKalamosApp(document);
    userTypeText(app, "draft");
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    await app.init();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.getContent()).toBe("draft");
  });

  it("status message combines extra and refused files", () => {
    expect(openWithStatusMessage("/tmp/kalamos-test/a.md", 2, ["x.txt", "y.pdf"])).toBe(
      "已開啟 a.md；另有 2 個檔案未開啟（Kalamos 一次開啟一個檔案）；無法開啟：x.txt、y.pdf（只支援一般的 Markdown 檔案）",
    );
    expect(openWithStatusMessage("/tmp/kalamos-test/a.md", 0, [])).toBe("");
  });
});
