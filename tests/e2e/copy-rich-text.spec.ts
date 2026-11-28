import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames, selectRange, setDoc } from "./helpers";

/**
 * #144: Copy as Rich Text / HTML (menu action, shortcut, real Canvas PNG
 * rasterization for MathJax & Mermaid, local image embedding/upload, and
 * dual text/html + text/plain clipboard output).
 */

const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function readClipboardPayload(page: Page): Promise<{
  html: string;
  plain: string;
  mockHtml: string;
  mockPlain: string;
}> {
  return page.evaluate(async () => {
    const ipc = await import("/src/ipc.ts" as string);
    const mock = ipc.getMockClipboardHtml();
    let html = "";
    let plain = "";
    if (navigator.clipboard && typeof navigator.clipboard.read === "function") {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            html = await (await item.getType("text/html")).text();
          }
          if (item.types.includes("text/plain")) {
            plain = await (await item.getType("text/plain")).text();
          }
        }
      } catch {
        // Fallback assertion uses mock when headless browser blocks clipboard.read.
      }
    }
    return {
      html,
      plain,
      mockHtml: mock?.html ?? "",
      mockPlain: mock?.plainText ?? "",
    };
  });
}

async function emitMenu(page: Page, action: string): Promise<void> {
  await page.evaluate(async (act) => {
    const ipc = await import("/src/ipc.ts" as string);
    await ipc.emitMockMenuAction(act, null);
  }, action);
  await nextFrames(page);
}

test.describe("#144 Copy as Rich Text / HTML", () => {
  test.beforeEach(async ({ context, page }) => {
    await context
      .grantPermissions(["clipboard-read", "clipboard-write"])
      .catch(() => null);
    await boot(page);
  });

  test("menu action copies whole document as clean rich HTML + plain Markdown without front matter", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const doc = [
      "---",
      "title: My Blog Post",
      "tags: [kalamos]",
      "---",
      "",
      "# 標題一",
      "",
      "這是一段包含 **粗體**、*斜體*、`inline` 與 [連結](https://example.com) 的文章。",
      "",
      "> 引用文字區塊",
      "",
      "- 項目 A",
      "- 項目 B",
      "",
      "1. 第一步",
      "2. 第二步",
      "",
      "- [x] 已完成",
      "- [ ] 待辦",
      "",
      "```ts",
      "function greet(name: string) {",
      '  return "Hello, " + name;',
      "}",
      "```",
      "",
      "| 欄位 | 說明 | 數值 |",
      "| :--- | :---: | ---: |",
      "| A | 中間 | 42 |",
      "",
      "行內公式 $e^{i\\pi}+1=0$。",
      "",
      "$$",
      "\\int_0^1 x\\,dx = \\frac{1}{2}",
      "$$",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[寫作] --> B[複製為富文字]",
      "```",
      "",
      "![本機圖](assets/demo.png)",
    ].join("\n");

    await page.evaluate(
      async ({ doc, png }) => {
        const ipc = await import("/src/ipc.ts" as string);
        const main = await import("/src/main.ts" as string);
        ipc.seedMockFile("/notes/blog.md", doc);
        ipc.seedMockImageDataUri("/notes/assets/demo.png", png, 128);
        await main.getActiveApp().openDocument("/notes/blog.md");
      },
      { doc, png: TINY_PNG_DATA_URI },
    );
    await nextFrames(page);

    await emitMenu(page, "edit.copyRichText");

    const status = page.getByTestId("status");
    await expect(status).toContainText("已複製為富文字");
    await expect(status).toContainText("已內嵌 1 張本機圖片");
    await expect(status).toHaveAttribute("data-error", "false");

    const clip = await readClipboardPayload(page);
    const html = clip.html || clip.mockHtml;
    const plain = clip.plain || clip.mockPlain;

    // Front matter must be excluded from both text/html and text/plain.
    expect(plain).not.toContain("My Blog Post");
    expect(plain).not.toContain("tags: [kalamos]");
    expect(plain.startsWith("# 標題一")).toBe(true);
    expect(html).not.toContain("My Blog Post");
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("var(--k-");

    // Headings, emphasis, lists, links, blockquote.
    expect(html).toContain("<h1>標題一</h1>");
    expect(html).toContain("<strong>粗體</strong>");
    expect(html).toContain("<em>斜體</em>");
    expect(html).toMatch(/<a href="https:\/\/example\.com\/?">連結<\/a>/);
    expect(html).toContain("<blockquote ");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("☑ 已完成");
    expect(html).toContain("☐ 待辦");

    // Code block preserves monospace font and newlines.
    expect(html).toMatch(/<pre style="[^"]*monospace[^"]*white-space:pre-wrap/);
    expect(html).toContain("\n  ");

    // Table structure with borders and column alignment.
    expect(html).toContain('<table style="border-collapse:collapse');
    expect(html).toContain("text-align:center;");
    expect(html).toContain("text-align:right;");

    // MathJax & Mermaid rasterized to real PNG data URIs (no raw <svg>).
    expect(html).not.toContain("<svg");
    const pngImgs = html.match(/<img src="data:image\/png;base64,/g) ?? [];
    // 2 math formulas + 1 Mermaid diagram + 1 embedded local PNG = 4 PNG <img> tags.
    expect(pngImgs.length).toBe(4);
    expect(html).toContain('alt="e^{i\\pi}+1=0"');
    expect(html).toContain('alt="mermaid diagram"');
    expect(html).toContain('alt="本機圖"');

    // Verify browser clipboard received both text/html and text/plain when supported.
    if (clip.html) {
      expect(clip.html).toContain("<h1>標題一</h1>");
      expect(clip.plain).toBe(clip.mockPlain);
    }
  });

  test("shortcut copies only the selection and keeps Cmd+Shift+C heading bookmark working", async ({
    page,
  }) => {
    const doc = [
      "---",
      "title: Ignored",
      "---",
      "",
      "# First Heading",
      "",
      "Alpha **beta** gamma.",
      "",
      "## Second Heading",
    ].join("\n");
    await setDoc(page, doc, 0);

    const start = doc.indexOf("Alpha");
    const end = doc.indexOf("gamma.") + "gamma.".length;
    await selectRange(page, start, end);

    await page.keyboard.press(`${MOD}+Alt+Shift+KeyC`);
    const status = page.getByTestId("status");
    await expect(status).toHaveText("已複製選取內容為富文字");

    const clip = await readClipboardPayload(page);
    const html = clip.html || clip.mockHtml;
    const plain = clip.plain || clip.mockPlain;
    expect(plain).toBe("Alpha **beta** gamma.");
    expect(html).toContain("<strong>beta</strong>");
    expect(html).not.toContain("First Heading");
    expect(html).not.toContain("Second Heading");
    expect(html).not.toContain("Ignored");

    // Cmd+Shift+C on a heading still copies its bookmark link (no shortcut conflict).
    const headingPos = doc.indexOf("## Second Heading") + 4;
    await selectRange(page, headingPos, headingPos);
    const bookmark = await page.evaluate(async () => {
      const lists = await import("/src/editor/lists.ts" as string);
      const main = await import("/src/main.ts" as string);
      return lists.copyHeadingBookmark(main.getActiveApp().editor.view);
    });
    expect(bookmark).toBe("[Second Heading](#second-heading)");
  });

  test("uploads local images when uploader is configured without altering the open document", async ({
    page,
  }) => {
    const doc = "# Photo Post\n\n![cat](assets/cat.png)\n";
    await page.evaluate(async (md) => {
      const ipc = await import("/src/ipc.ts" as string);
      const main = await import("/src/main.ts" as string);
      ipc.seedMockFile("/notes/photo.md", md);
      ipc.seedMockUploadSettings("/opt/homebrew/bin/picgo", ["upload"]);
      ipc.setMockUploadHandler(() => ({
        urls: ["https://cdn.example.test/cat.png"],
      }));
      await main.getActiveApp().openDocument("/notes/photo.md");
    }, doc);
    await nextFrames(page);

    await emitMenu(page, "edit.copyRichText");
    await expect(page.getByTestId("status")).toHaveText(
      "已複製為富文字（已上傳 1 張本機圖片）",
    );

    const clip = await readClipboardPayload(page);
    const html = clip.html || clip.mockHtml;
    expect(html).toContain('src="https://cdn.example.test/cat.png"');
    // Original Markdown document is untouched.
    expect(await getDoc(page)).toBe(doc);
  });

  test("shows clear status bar feedback across Papyros, Melan, and Nyx themes", async ({
    page,
  }) => {
    const shotsDir = process.env.KALAMOS_SHOTS_144_DIR;
    const doc = [
      "---",
      "title: Rich Text Copy Preview",
      "---",
      "",
      "# 複製為富文字預覽",
      "",
      "支援 **粗體**、*斜體*、`code` 與 [超連結](https://example.com)。",
      "",
      "| 項目 | 處理方式 |",
      "| :--- | :--- |",
      "| 程式碼 | 保留等寬字與換行 |",
      "| 表格 | 保留邊框與對齊 |",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n");

    await setDoc(page, doc, 0);
    await expect(page.getByTestId("word-count")).not.toHaveText("0 字");

    for (const theme of ["papyros", "melan", "nyx"] as const) {
      await page.evaluate(async (t) => {
        const main = await import("/src/main.ts" as string);
        main.applyTheme(t);
      }, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await emitMenu(page, "edit.copyRichText");
      const status = page.getByTestId("status");
      await expect(status).toHaveText("已複製為富文字");
      await expect(status).toBeVisible();
      if (shotsDir) {
        await page.screenshot({
          path: `${shotsDir}/copy-rich-text-${theme}.png`,
          fullPage: false,
        });
      }
    }
  });
});
