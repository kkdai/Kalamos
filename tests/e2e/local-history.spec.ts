import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames } from "./helpers";

async function menuAction(
  page: Page,
  action: string,
  arg: string | null = null,
): Promise<void> {
  await page.evaluate(
    async ({ action, arg }) => {
      const ipc = await import("/src/ipc.ts" as string);
      await ipc.emitMockMenuAction(action, arg);
    },
    { action, arg },
  );
  await nextFrames(page);
}

test.describe("#148 local version history", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("browses saved versions, previews diff, restores without writing disk, and supports undo", async ({
    page,
  }) => {
    const filePath = "/tmp/kalamos-test/history-doc.md";
    const v1 = ["# 產品筆記", "", "這是第一版草稿。", "保留的段落。"].join(
      "\n",
    );
    const v2 = [
      "# 產品筆記",
      "",
      "這是第二版草稿，補充了細節。",
      "保留的段落。",
    ].join("\n");
    const v3 = [
      "# 產品筆記",
      "",
      "這是目前最新版本。",
      "保留的段落。",
      "新增的結尾。",
    ].join("\n");

    await page.evaluate(
      async ({ filePath, v1, v2, v3 }) => {
        const ipc = await import("/src/ipc.ts" as string);
        const main = await import("/src/main.ts" as string);
        ipc.seedMockFile(filePath, v1);
        await ipc.saveFile(filePath, v2, { isAutosave: false });
        await ipc.saveFile(filePath, v3, { isAutosave: false });
        // Same content saved again must not add a duplicate snapshot
        await ipc.saveFile(filePath, v3, { isAutosave: false });
        await main.getActiveApp()!.openPath(filePath, "tab");
      },
      { filePath, v1, v2, v3 },
    );

    await expect.poll(() => getDoc(page)).toBe(v3);

    // Open Version History via native File > Browse Version History… menu action
    await menuAction(page, "file.versionHistory");
    const modal = page.getByTestId("history-modal");
    await expect(modal).toBeVisible();

    const items = page.getByTestId("history-item");
    await expect(items).toHaveCount(2);

    // First item (newest snapshot = v2) is selected by default
    await expect(items.nth(0)).toHaveAttribute("aria-selected", "true");
    const diff = page.getByTestId("history-diff");
    await expect(diff).toContainText("這是第二版草稿，補充了細節。");
    await expect(diff).toContainText("這是目前最新版本。");
    await expect(page.getByTestId("history-diff-added")).toHaveText("+2");
    await expect(page.getByTestId("history-diff-removed")).toHaveText("−1");

    // Select the older snapshot (v1)
    await items.nth(1).click();
    await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(diff).toContainText("這是第一版草稿。");

    // Click Restore: loads v1 into active tab without writing to disk
    await page.getByTestId("history-restore").click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => getDoc(page)).toBe(v1);

    const diskContentAfterRestore = await page.evaluate(async (p) => {
      const ipc = await import("/src/ipc.ts" as string);
      return ipc.readMockFile(p);
    }, filePath);
    expect(diskContentAfterRestore).toBe(v3);

    // Active tab is marked dirty, and Cmd/Ctrl+Z undoes the entire restore in one step
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const main = await import("/src/main.ts" as string);
          return main.getActiveApp()!.editor.isDirty();
        }),
      )
      .toBe(true);

    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => getDoc(page)).toBe(v3);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const main = await import("/src/main.ts" as string);
          return main.getActiveApp()!.editor.isDirty();
        }),
      )
      .toBe(false);
  });

  test("shows notice and disables restore for untitled documents", async ({
    page,
  }) => {
    await menuAction(page, "file.versionHistory");
    await expect(page.getByTestId("history-modal")).toBeVisible();
    await expect(page.getByTestId("history-preview-message")).toContainText(
      "請先儲存文件",
    );
    await expect(page.getByTestId("history-restore")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("history-modal")).toHaveCount(0);
  });

  test("preferences controls history retention, toggle, and clearing all history", async ({
    page,
  }) => {
    const filePath = "/tmp/kalamos-test/pref-history.md";
    await page.evaluate(async (p) => {
      const ipc = await import("/src/ipc.ts" as string);
      ipc.seedMockFile(p, "first");
      await ipc.saveFile(p, "second", { isAutosave: false });
    }, filePath);

    await menuAction(page, "app.preferences");
    await expect(page.getByTestId("preferences")).toBeVisible();

    await expect(page.getByTestId("pref-history-enabled")).toBeChecked();
    await expect(page.getByTestId("pref-history-notice")).toContainText(
      "1 個版本",
    );

    // Adjust retention settings
    await page.getByTestId("pref-history-max-versions").fill("30");
    await page.getByTestId("pref-history-max-versions").dispatchEvent("change");
    await page.getByTestId("pref-history-max-mb").fill("150");
    await page.getByTestId("pref-history-max-mb").dispatchEvent("change");

    // Disable history
    await page.getByTestId("pref-history-enabled").uncheck();
    await expect(page.getByTestId("pref-history-max-versions")).toBeDisabled();
    await expect(page.getByTestId("pref-history-max-mb")).toBeDisabled();

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const ipc = await import("/src/ipc.ts" as string);
          return ipc.getSettings();
        }),
      )
      .toMatchObject({
        historyEnabled: false,
        historyMaxVersions: 30,
        historyMaxTotalMb: 150,
      });

    // Clear all history via confirmation dialog
    await page.getByTestId("pref-history-clear").click();
    await expect(page.getByTestId("pref-history-clear-dialog")).toBeVisible();
    await page.getByTestId("pref-history-clear-confirm").click();

    await expect(page.getByTestId("pref-history-notice")).toContainText(
      "已清除所有本機版本歷史",
    );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const ipc = await import("/src/ipc.ts" as string);
          return ipc.getHistoryStats();
        }),
      )
      .toEqual({ totalBytes: 0, totalVersions: 0, fileCount: 0 });
  });
});
