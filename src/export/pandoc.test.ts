import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileMeta,
  getMockAllowedAssetDirs,
  getMockPandocExports,
  MOCK_PANDOC_IMPORT_MARKDOWN,
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  setMockPandocAvailable,
  setMockPandocExportHandler,
  setMockPandocImportHandler,
  setMockPandocVersion,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { pickExportFormat } from "./format-picker";
import {
  defaultExportPath,
  EXPORTING_MESSAGE,
  ensureExportExtension,
  exportedMessage,
  IMPORTING_MESSAGE,
  importedMessage,
  isImportablePath,
  PANDOC_FORMATS,
  PANDOC_MISSING_MESSAGE,
  prepareMarkdownForPandoc,
} from "./pandoc";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

function picker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-testid=export-format-picker]",
  );
}

function press(
  code: string,
  key = code.replace("Key", "").toLowerCase(),
): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, code, metaKey: true, altKey: true }),
  );
}

describe("EX-02 helpers", () => {
  it("default names follow the document and the format extension", () => {
    expect(defaultExportPath("/tmp/kalamos-test/notes/報告.md", "docx")).toBe(
      "/tmp/kalamos-test/notes/報告.docx",
    );
    expect(defaultExportPath("/tmp/kalamos-test/a.markdown", "latex")).toBe(
      "/tmp/kalamos-test/a.tex",
    );
    expect(defaultExportPath("/tmp/kalamos-test/a.md", "mediawiki")).toBe(
      "/tmp/kalamos-test/a.wiki",
    );
    expect(defaultExportPath(null, "epub")).toBe("未命名.epub");
    expect(ensureExportExtension("/tmp/kalamos-test/out", "odt")).toBe(
      "/tmp/kalamos-test/out.odt",
    );
    expect(ensureExportExtension("/tmp/kalamos-test/out.ODT", "odt")).toBe(
      "/tmp/kalamos-test/out.ODT",
    );
    expect(exportedMessage("docx", "/tmp/kalamos-test/a.docx")).toBe(
      "已匯出 DOCX：/tmp/kalamos-test/a.docx",
    );
    expect(importedMessage("/tmp/kalamos-test/報告.docx")).toBe(
      "已匯入：報告.docx",
    );
    expect(isImportablePath("/tmp/kalamos-test/a.DOCX")).toBe(true);
    expect(isImportablePath("/tmp/kalamos-test/a.pdf")).toBe(false);
    expect(isImportablePath("/tmp/kalamos.test/noext")).toBe(false);
  });

  it("prepares the document: absolute image paths, root, <img> sizes, [TOC] → --toc", () => {
    const md = [
      "---",
      "title: 測試",
      "---",
      "",
      "[TOC]",
      "",
      "# 標題",
      "",
      "![貓](assets/my%20cat.png) ![根](/img/a.png) ![遠端](https://example.com/x.png)",
      "",
      '<img src="pics/b.png" width="120" style="zoom:50%" onerror="x()" alt="B[1]">',
      "",
      "```md",
      "[TOC]",
      "![](/img/in-code.png)",
      "```",
      "",
      "- 清單",
    ].join("\n");
    const out = prepareMarkdownForPandoc(
      md,
      "/tmp/kalamos-test/notes/doc.md",
      "/tmp/kalamos-test/blog",
    );
    expect(out.toc).toBe(true);
    expect(out.imageRoot).toBe("/tmp/kalamos-test/blog");
    // The [TOC] paragraph is removed; the one inside the code block stays.
    expect(out.markdown.split("[TOC]").length - 1).toBe(1);
    expect(out.markdown).toContain(
      "![貓](</tmp/kalamos-test/notes/assets/my cat.png>)",
    );
    expect(out.markdown).toContain("![根](/tmp/kalamos-test/blog/img/a.png)");
    expect(out.markdown).toContain("![遠端](https://example.com/x.png)");
    expect(out.markdown).toContain(
      "![B\\[1\\]](/tmp/kalamos-test/notes/pics/b.png){width=120px}",
    );
    expect(out.markdown).not.toContain("onerror");
    // Code blocks are untouched; front matter and other content kept.
    expect(out.markdown).toContain("```md\n[TOC]\n![](/img/in-code.png)\n```");
    expect(out.markdown.startsWith("---\ntitle: 測試\n---")).toBe(true);
    expect(out.markdown).toContain("- 清單");
  });

  it("without a document path relative images stay as written; no [TOC] → toc false", () => {
    const out = prepareMarkdownForPandoc("![a](a.png)\n", null, null);
    expect(out).toEqual({
      markdown: "![a](a.png)\n",
      toc: false,
      imageRoot: null,
    });
  });
});

describe("EX-02 format picker", () => {
  beforeEach(() => setupDom());

  it("lists the five formats and resolves with the clicked one", async () => {
    const choice = pickExportFormat();
    const buttons = Array.from(
      picker()!.querySelectorAll<HTMLButtonElement>(".k-format-option"),
    );
    expect(buttons.map((b) => b.dataset.format)).toEqual(
      PANDOC_FORMATS.map((f) => f.id),
    );
    expect(buttons.map((b) => b.firstElementChild?.textContent)).toEqual([
      "DOCX",
      "ODT",
      "LaTeX",
      "MediaWiki",
      "EPUB",
    ]);
    expect(document.activeElement).toBe(buttons[0]);
    buttons[2].click();
    expect(await choice).toBe("latex");
    expect(picker()).toBeNull();
  });

  it("Escape, 取消 and a backdrop click cancel", async () => {
    let choice = pickExportFormat();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await choice).toBeNull();

    choice = pickExportFormat();
    document
      .querySelector<HTMLButtonElement>("[data-testid=export-format-cancel]")!
      .click();
    expect(await choice).toBeNull();

    choice = pickExportFormat();
    document
      .querySelector(".k-format-picker-backdrop")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(await choice).toBeNull();
    expect(document.querySelector(".k-format-picker-backdrop")).toBeNull();
  });
});

describe("EX-02 / EX-03 in the app", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    document.querySelector(".k-format-picker-backdrop")?.remove();
  });

  it("Cmd+Opt+E: format picker → save dialog named after the doc → 匯出中… → 已匯出", async () => {
    seedMockFile(
      "/tmp/kalamos-test/notes/Report.md",
      "# Title\n\n- a\n\n![x](img/x.png)\n",
    );
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/kalamos-test/notes/Report.md");

    const suggested: Array<string | null | undefined> = [];
    setMockDialogHandlers({
      save: (defaultPath) => {
        suggested.push(defaultPath);
        return "/tmp/kalamos-test/notes/out";
      },
    });
    let release: (meta: FileMeta) => void = () => {};
    setMockPandocExportHandler(
      (req) =>
        new Promise<FileMeta>((resolve) => {
          expect(req.format).toBe("odt");
          expect(req.outPath).toBe("/tmp/kalamos-test/notes/out.odt");
          expect(req.docPath).toBe("/tmp/kalamos-test/notes/Report.md");
          expect(req.markdown).toContain(
            "![x](/tmp/kalamos-test/notes/img/x.png)",
          );
          release = resolve;
        }),
    );

    press("KeyE", "´");
    await until(() => picker() !== null);
    picker()!.querySelector<HTMLButtonElement>("[data-format=odt]")!.click();
    await until(() => app!.getStatusText() === EXPORTING_MESSAGE);
    expect(suggested).toEqual(["/tmp/kalamos-test/notes/Report.odt"]);
    expect(app.isExportingPandoc()).toBe(true);
    release({ path: "/tmp/kalamos-test/notes/out.odt", mtimeMs: 1, size: 10 });
    await until(() => !app!.isExportingPandoc());
    expect(app.getStatusText()).toBe(
      "已匯出 ODT：/tmp/kalamos-test/notes/out.odt",
    );
    // The document text is untouched.
    expect(app.editor.getContent()).toBe("# Title\n\n- a\n\n![x](img/x.png)\n");
  });

  it("without pandoc: shows the install hint and never opens the picker or save dialog", async () => {
    app = createKalamosApp(document);
    await app.init();
    setMockPandocAvailable(false);
    let saveAsked = false;
    let openAsked = false;
    setMockDialogHandlers({
      save: () => {
        saveAsked = true;
        return "/tmp/kalamos-test/x.docx";
      },
      open: () => {
        openAsked = true;
        return "/tmp/kalamos-test/x.docx";
      },
    });
    expect(await app.exportDocumentAs()).toBe(false);
    expect(app.getStatusText()).toBe(PANDOC_MISSING_MESSAGE);
    expect(picker()).toBeNull();
    expect(await app.importDocument()).toBe(false);
    expect(app.getStatusText()).toBe(PANDOC_MISSING_MESSAGE);
    expect(saveAsked || openAsked).toBe(false);
    expect(getMockPandocExports()).toEqual([]);
  });

  it("export failures show 匯出失敗：…; cancelling picker or dialog does nothing", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("# a");
    setMockDialogHandlers({ save: () => null });
    expect(await app.exportDocumentAs("docx")).toBe(false);
    expect(app.getStatusText()).toBe("");

    const pending = app.exportDocumentAs();
    await until(() => picker() !== null);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBe(false);

    setMockPandocExportHandler(() => {
      throw {
        kind: "Io",
        message: "Pandoc 執行失敗（exit 83）：Could not find image",
      };
    });
    expect(await app.exportDocumentAs("latex", "/tmp/kalamos-test/a.tex")).toBe(
      false,
    );
    expect(app.getStatusText()).toBe(
      "匯出失敗：Pandoc 執行失敗（exit 83）：Could not find image",
    );
  });

  it("Cmd+Opt+I imports into a new untitled, dirty document", async () => {
    seedMockFile("/tmp/kalamos-test/notes/old.md", "舊內容");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/kalamos-test/notes/old.md");
    const oldId = app.getDocId();
    setMockDialogHandlers({ open: () => "/tmp/kalamos-test/in/報告.docx" });

    press("KeyI", "ˆ");
    await until(() => app!.getStatusText() === "已匯入：報告.docx");
    expect(app.editor.getContent()).toBe(MOCK_PANDOC_IMPORT_MARKDOWN);
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.isDirty()).toBe(true);
    expect(app.getDocId()).not.toBe(oldId);
  });

  it("import shows 匯入中…, allows the media folder, and failures keep the current document", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("保留");
    let release: () => void = () => {};
    setMockPandocImportHandler(
      (path) =>
        new Promise((resolve) => {
          expect(path).toBe("/tmp/kalamos-test/a.odt");
          release = () =>
            resolve({
              markdown: "![](/tmp/kalamos-test/media/image1.png)\n",
              mediaDir: "/tmp/kalamos-test/media",
            });
        }),
    );
    const done = app.importDocument("/tmp/kalamos-test/a.odt");
    await until(() => app!.getStatusText() === IMPORTING_MESSAGE);
    release();
    expect(await done).toBe(true);
    expect(getMockAllowedAssetDirs()).toContain("/tmp/kalamos-test/media");

    app.editor.setContent("目前文件");
    setMockPandocImportHandler(() => {
      throw { kind: "Io", message: "Pandoc 執行失敗（exit 1）" };
    });
    expect(await app.importDocument("/tmp/kalamos-test/b.docx")).toBe(false);
    expect(app.getStatusText()).toBe("匯入失敗：Pandoc 執行失敗（exit 1）");
    expect(app.editor.getContent()).toBe("目前文件");

    setMockPandocImportHandler(null);
    expect(await app.importDocument("/tmp/kalamos-test/c.pdf")).toBe(false);
    expect(app.getStatusText()).toMatch(/^匯入失敗：不支援匯入的檔案類型/);
  });

  it("a pandoc too old for --sandbox refuses imports with an upgrade hint; export still works", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("目前文件");
    setMockPandocVersion("2.14.2");
    expect(await app.importDocument("/tmp/kalamos-test/a.docx")).toBe(false);
    expect(app.getStatusText()).toBe(
      "匯入失敗：Pandoc 版本過舊，匯入需要 2.15 以上",
    );
    expect(app.editor.getContent()).toBe("目前文件");
    expect(await app.exportDocumentAs("docx", "/tmp/kalamos-test/a.docx")).toBe(
      true,
    );
    setMockPandocVersion("2.15");
    expect(await app.importDocument("/tmp/kalamos-test/a.docx")).toBe(true);
  });
});
