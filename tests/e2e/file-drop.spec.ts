import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, newPlatformContext } from "./helpers";

/** #88 (S4): drag-and-drop dispatch for Markdown files, Pandoc-importable files, and mixed images + Markdown. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

async function runWithApp<T>(
  page: Page,
  fn: string,
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const main = await import("/src/main.ts" as string);
      const ipc = await import("/src/ipc.ts" as string);
      const app = main.getActiveApp();
      return new Function(
        "app",
        "ipc",
        "arg",
        `return (async () => { ${fn} })();`,
      )(app, ipc, arg);
    },
    { fn, arg },
  );
}

test("#88 drop: Markdown files open in tabs using tab rules and ignore non-Markdown files", async ({
  page,
}) => {
  await runWithApp(
    page,
    `ipc.seedMockFile('/tmp/kalamos-test/one.md', '# First');
     ipc.seedMockFile('/tmp/kalamos-test/two.markdown', '# Second');
     await ipc.triggerMockFileDrop({ paths: ['/tmp/kalamos-test/one.md', '/tmp/kalamos-test/two.markdown', '/tmp/kalamos-test/skip.txt'] });`,
  );

  const tabs = page.getByTestId("tab");
  await expect(tabs).toHaveText(["one.md", "two.markdown"]);
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
  expect(await getDoc(page)).toBe("# Second");

  // Dropping an already-open Markdown file switches to its existing tab instead of duplicating it.
  await runWithApp(
    page,
    `await ipc.triggerMockFileDrop({ paths: ['/tmp/kalamos-test/one.md'] });`,
  );
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute("data-active", "true");
  expect(await getDoc(page)).toBe("# First");
});

test("#88 drop: importable DOCX file imports via Pandoc into a new untitled tab", async ({
  page,
}) => {
  await runWithApp(
    page,
    `ipc.seedMockFile('/tmp/kalamos-test/existing.md', 'Existing doc');
     await app.openDocument('/tmp/kalamos-test/existing.md');
     await ipc.triggerMockFileDrop({ paths: ['/tmp/kalamos-test/notes.docx'] });`,
  );

  await expect(page.getByTestId("status")).toHaveText("已匯入：notes.docx");
  const tabs = page.getByTestId("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
  await expect(tabs.nth(1)).toHaveAttribute("data-dirty", "true");
  const canned = await runWithApp<string>(
    page,
    "return ipc.MOCK_PANDOC_IMPORT_MARKDOWN;",
  );
  expect(await getDoc(page)).toBe(canned);
});

test("#88 drop: mixed image + Markdown inserts image in current doc and opens Markdown in a tab", async ({
  page,
}) => {
  await runWithApp(
    page,
    `ipc.seedMockFile('/tmp/kalamos-test/doc.md', 'Body\\n');
     ipc.seedMockFile('/tmp/kalamos-test/extra.md', '# Extra');
     await app.openDocument('/tmp/kalamos-test/doc.md');
     await ipc.triggerMockFileDrop({ paths: ['/tmp/kalamos-test/pic.png', '/tmp/kalamos-test/extra.md'] });`,
  );

  const tabs = page.getByTestId("tab");
  await expect(tabs).toHaveText(["doc.md", "extra.md"]);
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
  expect(await getDoc(page)).toBe("# Extra");

  // Switch back to the original document and verify the dropped image was inserted there.
  await tabs.nth(0).click();
  expect(await getDoc(page)).toContain("![](assets/pic.png)");
});

test("#88 UI: top-left floating quick buttons show only on Windows and Preferences use Ctrl/Alt labels", async ({
  browser,
}) => {
  // macOS: no top-left floating quick buttons (actions live in the native menu bar).
  const macCtx = await newPlatformContext(browser, "macos");
  try {
    const macPage = await macCtx.newPage();
    await boot(macPage);
    await expect(macPage.getByTestId("open-file-button")).toHaveCount(0);
    await expect(macPage.getByTestId("sidebar-toggle-button")).toHaveCount(0);
  } finally {
    await macCtx.close();
  }

  // Windows: top-left quick buttons are rendered and Preferences rewrite Cmd/Opt to Ctrl/Alt.
  const winCtx = await newPlatformContext(browser, "windows");
  try {
    const winPage = await winCtx.newPage();
    await boot(winPage);
    await expect(winPage.getByTestId("open-file-button")).toBeVisible();
    await expect(winPage.getByTestId("sidebar-toggle-button")).toBeVisible();
    await expect(winPage.getByTestId("open-file-button")).toHaveAttribute(
      "title",
      "開啟檔案 (Ctrl+O)",
    );

    await runWithApp(winPage, "await app.preferences.open('editor');");
    await expect(winPage.getByTestId("preferences")).toContainText(
      "Ctrl+Alt+P",
    );
    await expect(winPage.getByTestId("preferences")).not.toContainText(
      "Cmd+Opt+P",
    );
  } finally {
    await winCtx.close();
  }
});

test("#88 Windows shortcuts: Control+Shift+o opens folder even with lowercase key (Caps Lock / synthetic)", async ({
  browser,
}) => {
  const winCtx = await newPlatformContext(browser, "windows");
  try {
    const winPage = await winCtx.newPage();
    await boot(winPage);
    await runWithApp(
      winPage,
      "ipc.setMockDialogHandlers({ openFolder: () => '/demo', open: () => '/demo/welcome.md', save: () => '/demo/copy.md' });",
    );
    await winPage.getByTestId("editor").click();
    await winPage.keyboard.press("Control+Shift+o");
    await expect(winPage.getByTestId("sidebar-folder-title")).toContainText(
      "demo",
    );
    await expect(winPage.locator("#sidebar")).toHaveAttribute(
      "data-visible",
      "true",
    );

    // Control+o still opens a file, and Control+Shift+s on a saved file still triggers Save As.
    await winPage.getByTestId("editor").click();
    await winPage.keyboard.press("Control+o");
    await expect
      .poll(() =>
        runWithApp<string | null>(winPage, "return app.getCurrentPath();"),
      )
      .toBe("/demo/welcome.md");
    await winPage.keyboard.press("Control+Shift+s");
    await expect
      .poll(() =>
        runWithApp<string | null>(winPage, "return app.getCurrentPath();"),
      )
      .toBe("/demo/copy.md");
  } finally {
    await winCtx.close();
  }
});
