import { describe, expect, it } from "vitest";
import { dirname, joinPath, resolveImageRoot, resolveImageSrc } from "./editor/images";
import { resolveRelativeMarkdownPath } from "./editor/lists";
import { fileUrlFromPath } from "./export/html";
import { resetMockState, seedMockFile, setMockDialogHandlers, triggerMockFileDrop } from "./ipc";
import { createKalamosApp } from "./main";
import {
  isAbsolutePath,
  isDrivePath,
  isMarkdownFilePath,
  pathRoot,
  toCtrlLabel,
  windowsToSlash,
} from "./platform";

describe("platform (Windows & cross-platform helpers)", () => {
  it("converts Windows paths (and \\\\?\\ verbatim paths) to forward slashes", () => {
    expect(windowsToSlash("C:\\Users\\me\\notes\\a.md")).toBe("C:/Users/me/notes/a.md");
    expect(windowsToSlash("\\\\?\\C:\\Users\\me\\a.md")).toBe("C:/Users/me/a.md");
    expect(windowsToSlash("\\\\?\\UNC\\srv\\share\\a.md")).toBe("//srv/share/a.md");
  });

  it("detects Unix, drive and UNC roots", () => {
    expect(pathRoot("/Users/me/a.md")).toBe("/");
    expect(pathRoot("C:/Users/me/a.md")).toBe("C:/");
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
    expect(dirname("C:/Users/me/notes/a.md")).toBe("C:/Users/me/notes");
    expect(dirname("C:/a.md")).toBe("C:/");
    expect(joinPath("C:/Users/me/notes", "assets/pic.png")).toBe(
      "C:/Users/me/notes/assets/pic.png",
    );
    expect(joinPath("C:/Users/me/notes", "../images/pic.png")).toBe(
      "C:/Users/me/images/pic.png",
    );
    expect(joinPath("C:/Users/me", "../../../../etc/passwd")).toBe("C:/etc/passwd");
    expect(joinPath("C:/Users/me", "../../..")).toBe("C:");
  });

  it("resolves image sources and roots with Windows paths and file:///C:/ URLs", () => {
    const id = (p: string) => `asset:${p}`;
    expect(
      resolveImageSrc("assets/pic.png", "C:/Users/me/blog/post.md", id),
    ).toEqual({
      kind: "local",
      path: "C:/Users/me/blog/assets/pic.png",
      url: "asset:C:/Users/me/blog/assets/pic.png",
    });
    expect(
      resolveImageSrc("/img/a.png", "C:/Users/me/blog/post.md", id, "C:/Users/me/blog/static"),
    ).toEqual({
      kind: "local",
      path: "C:/Users/me/blog/static/img/a.png",
      url: "asset:C:/Users/me/blog/static/img/a.png",
    });
    expect(resolveImageSrc("file:///C:/Users/me/pic.png", null, id)).toEqual({
      kind: "local",
      path: "C:/Users/me/pic.png",
      url: "asset:C:/Users/me/pic.png",
    });
    expect(resolveImageRoot("C:\\Users\\me\\root", null, null)).toBe("C:/Users/me/root");
    expect(resolveImageRoot(null, null, "D:/blog/static")).toBe("D:/blog/static");
  });

  it("resolves relative Markdown links from a Windows document path", () => {
    expect(resolveRelativeMarkdownPath("C:/Users/me/docs/a.md", "../readme.md")).toBe(
      "C:/Users/me/readme.md",
    );
  });

  it("turns Windows paths into file:///C:/... URLs for export HTML", () => {
    expect(fileUrlFromPath("C:/Users/me/我的 筆記/pic.png")).toBe(
      `file:///C:/Users/me/${encodeURIComponent("我的 筆記")}/pic.png`,
    );
    expect(fileUrlFromPath("/Users/me/pic.png")).toBe("file:///Users/me/pic.png");
  });

  it("rewrites macOS shortcut labels as Ctrl/Alt/Shift for Windows & Linux", () => {
    expect(toCtrlLabel("開啟資料夾 (Cmd+Shift+O)")).toBe("開啟資料夾 (Ctrl+Shift+O)");
    expect(toCtrlLabel("Cmd+Opt+T")).toBe("Ctrl+Alt+T");
    expect(toCtrlLabel("上一個（⇧⌘G）")).toBe("上一個（Ctrl+Shift+G）");
    expect(toCtrlLabel("下一個（⌘G）")).toBe("下一個（Ctrl+G）");
    expect(toCtrlLabel("全部取代（⌘Enter）")).toBe("全部取代（Ctrl+Enter）");
    expect(toCtrlLabel("欄靠左（⌥⇧⌘←）")).toBe("欄靠左（Ctrl+Alt+Shift+←）");
    expect(toCtrlLabel("刪除列（⇧⌘⌫）")).toBe("刪除列（Ctrl+Shift+Backspace）");
    expect(toCtrlLabel("⌥⌘↓")).toBe("Ctrl+Alt+↓");
  });

  it("recognizes all Markdown extensions and opens a dropped .md file or top-left buttons", async () => {
    expect(isMarkdownFilePath("C:/notes/a.md")).toBe(true);
    expect(isMarkdownFilePath("C:/notes/a.MKDN")).toBe(true);
    expect(isMarkdownFilePath("C:/notes/a.txt")).toBe(false);

    resetMockState();
    document.body.innerHTML = `<div id="app"><aside id="sidebar" data-visible="false"></aside><main id="editor-container"></main><div id="status"></div></div>`;
    seedMockFile("/tmp/drop-open.md", "# 拖放開啟\n");
    seedMockFile("/tmp/btn-open.md", "# 按鈕開啟\n");
    setMockDialogHandlers({ open: () => "/tmp/btn-open.md" });

    const app = createKalamosApp(document);
    await app.init();

    // Drag & drop a Markdown file onto the window opens it.
    await triggerMockFileDrop({ paths: ["/tmp/drop-open.md"] });
    expect(app.getCurrentPath()).toBe("/tmp/drop-open.md");
    expect(app.editor.getContent()).toBe("# 拖放開啟\n");

    // Top-left open-file button opens the file picker.
    document.querySelector<HTMLButtonElement>('[data-testid="open-file-button"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.getCurrentPath()).toBe("/tmp/btn-open.md");

    // Top-left sidebar-toggle button opens and closes the sidebar.
    expect(app.sidebar.isVisible()).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle-button"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.sidebar.isVisible()).toBe(true);

    app.destroy();
  });
});
