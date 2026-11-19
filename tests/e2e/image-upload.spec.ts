import { expect, test } from "@playwright/test";
import { boot, getDoc } from "./helpers";

/** #19 IM-05: upload images with the configured command (mock uploader in the browser). */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const DOC_PATH = "/tmp/kalamos-test/notes/post.md";

async function openWith(page: import("@playwright/test").Page, content: string, configure: boolean) {
  await page.evaluate(
    async ({ path, content, configure }) => {
      const ipc = await import("/src/ipc.ts" as string);
      ipc.seedMockFile(path, content);
      if (configure) {
        // Stands in for editing settings.json (the app cannot set the uploader).
        ipc.seedMockUploadSettings("/tmp/kalamos-test/bin/picgo", ["upload"]);
      }
      const app = (await import("/src/main.ts" as string)).getActiveApp();
      await app.openDocument(path);
      app.editor.view.focus();
    },
    { path: DOC_PATH, content, configure },
  );
}

test("#19 AC: Cmd+Opt+U replaces the image under the cursor with the remote URL; undo restores", async ({ page }) => {
  const src = '# Post\n\n![shot](assets/shot.png "Screen")\n\n<img src="assets/b.png" width="100">\n';
  await openWith(page, src, true);
  await page.evaluate(async (pos) => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    app.editor.setCursor(pos);
  }, src.indexOf("shot]"));
  await page.keyboard.press("ControlOrMeta+Alt+KeyU");
  await expect(page.getByTestId("status")).toHaveText("已上傳 1 張圖片");
  await expect
    .poll(() => getDoc(page))
    .toBe('# Post\n\n![shot](https://mock-images.kalamos.test/shot.png "Screen")\n\n<img src="assets/b.png" width="100">\n');

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => getDoc(page)).toBe(src);

  // No image under the cursor: every local image is uploaded.
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    app.editor.setCursor(0);
  });
  await page.keyboard.press("ControlOrMeta+Alt+KeyU");
  await expect(page.getByTestId("status")).toHaveText("已上傳 2 張圖片");
  await expect.poll(() => getDoc(page)).toContain('<img src="https://mock-images.kalamos.test/b.png" width="100">');
  await expect.poll(() => getDoc(page)).toContain("![shot](https://mock-images.kalamos.test/shot.png");
});

test("#19 without an uploader the status explains how to set one up", async ({ page }) => {
  const src = "![a](assets/a.png)\n";
  await openWith(page, src, false);
  await page.keyboard.press("ControlOrMeta+Alt+KeyU");
  await expect(page.getByTestId("status")).toHaveText("尚未設定圖床上傳指令（見 docs/image-upload.md）");
  expect(await getDoc(page)).toBe(src);
});
