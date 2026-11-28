import { expect, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames, withIpc } from "./helpers";

/**
 * Frontend halves of AC2 / AC4 / AC11 against the ipc mock. The disk-level
 * parts (real bytes on disk, atomic rename, force-quit, real fs watcher) are
 * covered by cargo test + manual steps in .herdr/qa/harness-plan.md.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("AC2 Cmd+O opens, Cmd+S on an unedited CRLF/BOM/no-final-newline file writes identical content", async ({
  page,
}) => {
  const original = "﻿# 標題\r\n\r\n內文 **粗體**\r\n最後一行沒有換行";
  await withIpc(
    page,
    "ipc.seedMockFile('/demo/crlf.md', arg); ipc.setMockDialogHandlers({ open: () => '/demo/crlf.md' });",
    original,
  );
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${MOD}+o`);
  await expect.poll(() => getDoc(page)).toBe(original);
  // Saving re-writes the file; content must be byte-for-byte (string) identical.
  await withIpc(
    page,
    `window.__savedPayload = null;
     ipc.setMockSaveInterceptor(async (_path, content, defaultSave) => {
       window.__savedPayload = content;
       return defaultSave();
     });`,
  );
  await page.keyboard.press(`${MOD}+s`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __savedPayload: string | null })
            .__savedPayload,
      ),
    )
    .toBe(original);
  expect(
    await withIpc<string>(page, "return ipc.readMockFile('/demo/crlf.md');"),
  ).toBe(original);
});

test("AC2 Cmd+Shift+S saves as a new path; Cmd+N starts an empty document", async ({
  page,
}) => {
  await withIpc(
    page,
    "ipc.setMockDialogHandlers({ save: () => '/demo/new-name.md', ask: () => true });",
  );
  await page.getByTestId("editor").click();
  await page.keyboard.type("另存新檔");
  await page.keyboard.press(`${MOD}+Shift+s`);
  await expect
    .poll(() =>
      withIpc<string>(page, "return ipc.readMockFile('/demo/new-name.md');"),
    )
    .toBe("另存新檔");
  await page.keyboard.press(`${MOD}+n`);
  await expect.poll(() => getDoc(page)).toBe("");
});

test("AC4 named file autosaves ~1 s after typing stops", async ({ page }) => {
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openDocument("/demo/notes.md");
    app.editor.view.focus();
    app.editor.setCursor(app.editor.view.state.doc.length);
  });
  const before = await withIpc<string>(
    page,
    "return ipc.readMockFile('/demo/notes.md');",
  );
  await page.keyboard.type(" 新增");
  await page.waitForTimeout(500);
  expect(
    await withIpc<string>(page, "return ipc.readMockFile('/demo/notes.md');"),
  ).toBe(before);
  await expect
    .poll(
      () => withIpc<string>(page, "return ipc.readMockFile('/demo/notes.md');"),
      { timeout: 3_000 },
    )
    .toBe(`${before} 新增`);
});

test("AC4 untitled document is written to recovery every 5 s; restore brings it back", async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.getByTestId("editor").click();
  await page.keyboard.type("未命名草稿");
  await expect
    .poll(
      () =>
        withIpc<string[]>(
          page,
          "return (await ipc.listRecovery()).map((e) => e.content);",
        ),
      {
        timeout: 7_000,
      },
    )
    .toContain("未命名草稿");

  // Simulate a relaunch: fresh editor state, then init() sees the recovery entry.
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    app.editor.setContent("", { dirty: false });
    await app.init();
  });
  await expect(page.locator("#recovery-banner")).toHaveAttribute(
    "data-visible",
    "true",
  );
  await page.locator("#recovery-restore-btn").click();
  await expect.poll(() => getDoc(page)).toBe("未命名草稿");
  await expect(page.locator("#recovery-banner")).toHaveAttribute(
    "data-visible",
    "false",
  );
});

test("AC11 fs-changed event refreshes the sidebar (add / rename / delete)", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openFolder("/demo");
    if (!app.sidebar.isVisible()) await app.toggleSidebar();
  });
  await page.getByTestId("sidebar-tab-list").click();
  const items = page.getByTestId("file-item");
  await expect(items.filter({ hasText: "added.md" })).toHaveCount(0);

  await withIpc(
    page,
    "ipc.seedMockFile('/demo/added.md', '# added'); await ipc.triggerMockFsChanged({ root: '/demo', paths: ['/demo/added.md'] });",
  );
  await expect(items.filter({ hasText: "added.md" })).toHaveCount(1);

  await withIpc(
    page,
    "await ipc.renamePath('/demo/added.md', '/demo/renamed.md'); await ipc.triggerMockFsChanged({ root: '/demo', paths: ['/demo/renamed.md'] });",
  );
  await expect(items.filter({ hasText: "renamed.md" })).toHaveCount(1);
  await expect(items.filter({ hasText: "added.md" })).toHaveCount(0);

  await withIpc(
    page,
    "await ipc.trashPath('/demo/renamed.md'); await ipc.triggerMockFsChanged({ root: '/demo', paths: ['/demo/renamed.md'] });",
  );
  await expect(items.filter({ hasText: "renamed.md" })).toHaveCount(0);
  await nextFrames(page);
});
