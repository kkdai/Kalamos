import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileMeta,
  getMockPdfExports,
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  setMockExportPdfHandler,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

function pressExportShortcut(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "E",
      code: "KeyE",
      metaKey: true,
      shiftKey: true,
    }),
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

describe("EX-01 export PDF from the app", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("Cmd+Shift+E asks for a path named after the document and reports the result", async () => {
    seedMockFile("/notes/Report.md", "# Title\n\n## Part\n\ntext\n");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/notes/Report.md");

    const suggested: Array<string | null | undefined> = [];
    setMockDialogHandlers({
      save: (defaultPath) => {
        suggested.push(defaultPath);
        return "/notes/out";
      },
    });
    let release: (meta: FileMeta) => void = () => {};
    setMockExportPdfHandler(
      (job) =>
        new Promise<FileMeta>((resolve) => {
          release = resolve;
          expect(job.outPath).toBe("/notes/out.pdf");
          expect(job.headings).toEqual([
            { level: 1, text: "Title", id: "title" },
            { level: 2, text: "Part", id: "part" },
          ]);
          expect(job.html).toContain('<h1 id="title">Title</h1>');
        }),
    );

    pressExportShortcut();
    await until(() => app!.getStatusText() === "匯出中…");
    expect(suggested).toEqual(["/notes/Report.pdf"]);
    expect(app.isExportingPdf()).toBe(true);
    // A second shortcut while exporting is ignored.
    pressExportShortcut();
    expect(suggested).toHaveLength(1);

    release({ path: "/notes/out.pdf", mtimeMs: 1, size: 10 });
    await until(() => !app!.isExportingPdf());
    expect(app.getStatusText()).toBe("已匯出 PDF：/notes/out.pdf");
    expect(document.getElementById("status")!.dataset.error).toBe("false");
  });

  it("exports an untitled document and clears the busy state after a failure", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("# 未命名標題\n", { dirty: true });
    setMockDialogHandlers({ save: (p) => `/tmp/${p}` });

    setMockExportPdfHandler(() =>
      Promise.reject({ kind: "Io", message: "匯出 PDF 逾時（60 秒）" }),
    );
    expect(await app.exportDocumentPdf()).toBe(false);
    expect(app.getStatusText()).toBe("匯出 PDF 失敗：匯出 PDF 逾時（60 秒）");
    expect(document.getElementById("status")!.dataset.error).toBe("true");
    expect(app.isExportingPdf()).toBe(false);

    setMockExportPdfHandler(null);
    expect(await app.exportDocumentPdf()).toBe(true);
    const [job] = getMockPdfExports();
    expect(job.outPath).toBe("/tmp/未命名.pdf");
    expect(job.headings).toEqual([
      { level: 1, text: "未命名標題", id: "未命名標題" },
    ]);
    expect(app.getStatusText()).toBe("已匯出 PDF：/tmp/未命名.pdf");
  });

  it("does nothing when the save dialog is cancelled", async () => {
    app = createKalamosApp(document);
    await app.init();
    setMockDialogHandlers({ save: () => null });
    expect(await app.exportDocumentPdf()).toBe(false);
    expect(getMockPdfExports()).toHaveLength(0);
    expect(app.getStatusText()).toBe("");
  });
});
