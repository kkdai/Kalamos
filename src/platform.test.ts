import { describe, expect, it } from "vitest";
import {
  dirname,
  joinPath,
  resolveImageRoot,
  resolveImageSrc,
} from "./editor/images";
import { resolveRelativeMarkdownPath } from "./editor/lists";
import { fileUrlFromPath } from "./export/html";
import {
  isMarkdownName,
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  triggerMockFileDrop,
} from "./ipc";
import { createKalamosApp } from "./main";
import {
  isAbsolutePath,
  isDrivePath,
  isMarkdownFilePath,
  pathRoot,
  shortcutLabel,
  slashToWindows,
  toCtrlLabel,
  windowsToSlash,
} from "./platform";

describe("platform (Windows & cross-platform helpers)", () => {
  it("converts Windows paths (and \\\\?\\ verbatim paths) to forward slashes and back", () => {
    expect(windowsToSlash("C:\\Docs\\kalamos-test\\notes\\a.md")).toBe(
      "C:/Docs/kalamos-test/notes/a.md",
    );
    expect(windowsToSlash("\\\\?\\C:\\Docs\\kalamos-test\\a.md")).toBe(
      "C:/Docs/kalamos-test/a.md",
    );
    expect(windowsToSlash("\\\\?\\UNC\\srv\\share\\a.md")).toBe(
      "//srv/share/a.md",
    );
    expect(slashToWindows("C:/Docs/kalamos-test/notes/a.md")).toBe(
      "C:\\Docs\\kalamos-test\\notes\\a.md",
    );
    expect(slashToWindows("guides/sub")).toBe("guides\\sub");
  });

  it("detects Unix, drive and UNC roots", () => {
    expect(pathRoot("/tmp/kalamos-test/a.md")).toBe("/");
    expect(pathRoot("C:/Docs/kalamos-test/a.md")).toBe("C:/");
    expect(pathRoot("C:")).toBe("C:/");
    expect(pathRoot("//server/share/a.md")).toBe("//server/share/");
    expect(pathRoot("relative/a.md")).toBe("");

    expect(isAbsolutePath("/a")).toBe(true);
    expect(isAbsolutePath("D:/a")).toBe(true);
    expect(isAbsolutePath("D:\\a")).toBe(true);
    expect(isAbsolutePath("//srv/share/a")).toBe(true);
    expect(isAbsolutePath("notes/a.md")).toBe(false);

    expect(isDrivePath("C:/a")).toBe(true);
    expect(isDrivePath("c:\\a")).toBe(true);
    expect(isDrivePath("https://example.com")).toBe(false);
  });

  it("dirname and joinPath preserve Windows drive roots", () => {
    expect(dirname("C:/Docs/kalamos-test/notes/a.md")).toBe(
      "C:/Docs/kalamos-test/notes",
    );
    expect(dirname("C:/a.md")).toBe("C:/");
    expect(joinPath("C:/Docs/kalamos-test/notes", "assets/pic.png")).toBe(
      "C:/Docs/kalamos-test/notes/assets/pic.png",
    );
    expect(joinPath("C:/Docs/kalamos-test/notes", "../images/pic.png")).toBe(
      "C:/Docs/kalamos-test/images/pic.png",
    );
    expect(joinPath("C:/Docs/kalamos-test", "../../../../etc/passwd")).toBe(
      "C:/etc/passwd",
    );
    expect(joinPath("C:/Docs/kalamos-test", "../../..")).toBe("C:");
  });

  it("resolves image sources and roots with Windows paths and file:///C:/ URLs", () => {
    const id = (p: string) => `asset:${p}`;
    expect(
      resolveImageSrc(
        "assets/pic.png",
        "C:/Docs/kalamos-test/blog/post.md",
        id,
      ),
    ).toEqual({
      kind: "local",
      path: "C:/Docs/kalamos-test/blog/assets/pic.png",
      url: "asset:C:/Docs/kalamos-test/blog/assets/pic.png",
    });
    expect(
      resolveImageSrc(
        "/img/a.png",
        "C:/Docs/kalamos-test/blog/post.md",
        id,
        "C:/Docs/kalamos-test/blog/static",
      ),
    ).toEqual({
      kind: "local",
      path: "C:/Docs/kalamos-test/blog/static/img/a.png",
      url: "asset:C:/Docs/kalamos-test/blog/static/img/a.png",
    });
    expect(
      resolveImageSrc("file:///C:/Docs/kalamos-test/pic.png", null, id),
    ).toEqual({
      kind: "local",
      path: "C:/Docs/kalamos-test/pic.png",
      url: "asset:C:/Docs/kalamos-test/pic.png",
    });
    expect(
      resolveImageRoot("C:\\Docs\\kalamos-test\\root", null, null, true),
    ).toBe("C:/Docs/kalamos-test/root");
    // Non-Windows platforms ignore Windows drive paths in front matter and fall back to settingRoot.
    expect(
      resolveImageRoot("C:/Docs/kalamos-test/root", null, "/blog", false),
    ).toBe("/blog");
    expect(resolveImageRoot(null, null, "D:/blog/static")).toBe(
      "D:/blog/static",
    );
  });

  it("resolves relative Markdown links from a Windows document path", () => {
    expect(
      resolveRelativeMarkdownPath(
        "C:/Docs/kalamos-test/docs/a.md",
        "../readme.md",
      ),
    ).toBe("C:/Docs/kalamos-test/readme.md");
  });

  it("turns Windows paths into file:///C:/... URLs for export HTML", () => {
    expect(fileUrlFromPath("C:/Docs/kalamos-test/我的 筆記/pic.png")).toBe(
      `file:///C:/Docs/kalamos-test/${encodeURIComponent("我的 筆記")}/pic.png`,
    );
    expect(fileUrlFromPath("/tmp/kalamos-test/pic.png")).toBe(
      "file:///tmp/kalamos-test/pic.png",
    );
  });

  it("rewrites macOS shortcut labels as Ctrl/Alt/Shift for Windows & Linux", () => {
    expect(toCtrlLabel("開啟資料夾 (Cmd+Shift+O)")).toBe(
      "開啟資料夾 (Ctrl+Shift+O)",
    );
    expect(toCtrlLabel("Cmd+Opt+T")).toBe("Ctrl+Alt+T");
    expect(toCtrlLabel("上一個（⇧⌘G）")).toBe("上一個（Ctrl+Shift+G）");
    expect(toCtrlLabel("下一個（⌘G）")).toBe("下一個（Ctrl+G）");
    expect(toCtrlLabel("全部取代（⌘Enter）")).toBe("全部取代（Ctrl+Enter）");
    expect(toCtrlLabel("欄靠左（⌥⇧⌘←）")).toBe("欄靠左（Ctrl+Alt+Shift+←）");
    expect(toCtrlLabel("刪除列（⇧⌘⌫）")).toBe("刪除列（Ctrl+Shift+Backspace）");
    expect(toCtrlLabel("⌥⌘↓")).toBe("Ctrl+Alt+↓");
    expect(toCtrlLabel("偏好設定（⌘,）")).toBe("偏好設定（Ctrl+,）");
    expect(toCtrlLabel("下一個分頁（⌃⇥）")).toBe("下一個分頁（Ctrl+Tab）");
    expect(toCtrlLabel("放大（⇧⌘=）")).toBe("放大（Ctrl+Shift+=）");

    expect(shortcutLabel("新增分頁（⌘T）", false)).toBe("新增分頁（⌘T）");
    expect(shortcutLabel("新增分頁（⌘T）", true)).toBe("新增分頁（Ctrl+T）");
    expect(shortcutLabel("自動配對（Cmd+Opt+P）", false)).toBe(
      "自動配對（Cmd+Opt+P）",
    );
    expect(shortcutLabel("自動配對（Cmd+Opt+P）", true)).toBe(
      "自動配對（Ctrl+Alt+P）",
    );
  });

  it("recognizes all Markdown extensions and opens a dropped .md file; quick buttons are Windows-only", async () => {
    expect(isMarkdownFilePath("C:/notes/a.md")).toBe(true);
    expect(isMarkdownFilePath("C:/notes/a.MKDN")).toBe(true);
    expect(isMarkdownFilePath("C:/notes/a.txt")).toBe(false);
    expect(isMarkdownFilePath("/x/.md")).toBe(false);
    expect(isMarkdownFilePath("C:\\x\\.md")).toBe(false);
    expect(isMarkdownName("note.mdown")).toBe(true);
    expect(isMarkdownName(".md")).toBe(false);

    resetMockState();
    document.body.innerHTML = `<div id="app"><aside id="sidebar" data-visible="false"></aside><main id="editor-container"></main><div id="status"></div></div>`;
    seedMockFile("/tmp/drop-open.md", "# 拖放開啟\n");
    seedMockFile("/tmp/btn-open.md", "# 按鈕開啟\n");
    setMockDialogHandlers({ open: () => "/tmp/btn-open.md" });

    // Non-Windows (default in jsdom): top-left quick buttons are not rendered.
    const macApp = createKalamosApp(document);
    await macApp.init();
    expect(
      document.querySelector('[data-testid="open-file-button"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="sidebar-toggle-button"]'),
    ).toBeNull();

    // Drag & drop a Markdown file onto the window opens it in a tab.
    await triggerMockFileDrop({ paths: ["/tmp/drop-open.md"] });
    expect(macApp.getCurrentPath()).toBe("/tmp/drop-open.md");
    expect(macApp.editor.getContent()).toBe("# 拖放開啟\n");
    macApp.destroy();

    // Windows: top-left quick buttons are rendered and functional.
    const winApp = createKalamosApp(document, { showQuickButtons: true });
    await winApp.init();
    document
      .querySelector<HTMLButtonElement>('[data-testid="open-file-button"]')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(winApp.getCurrentPath()).toBe("/tmp/btn-open.md");

    expect(winApp.sidebar.isVisible()).toBe(false);
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-toggle-button"]',
      )!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(winApp.sidebar.isVisible()).toBe(true);

    winApp.destroy();
  });
});
