import { expect, test } from "@playwright/test";
import { boot, getDoc, withIpc } from "./helpers";

/**
 * #67: files handed over by Finder / Dock / `open -a Kalamos x.md`.
 * The mock's triggerMockOpenFiles stands in for Rust's RunEvent::Opened →
 * `kalamos://open-files` (paths already filtered + canonical on the Rust side).
 * Cold-launch queueing is covered by vitest (src/open-with.test.ts) and cargo test.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("#67 opened event loads the file in the current window and syncs the sidebar", async ({ page }) => {
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openFolder("/demo");
    if (!app.sidebar.isVisible()) await app.toggleSidebar();
  });
  await page.getByTestId("sidebar-tab-list").click();

  await withIpc(page, "await ipc.triggerMockOpenFiles({ paths: ['/demo/notes.md'] });");
  await expect.poll(() => getDoc(page)).toContain("技術筆記 Architecture Notes");
  await expect(
    page.getByTestId("file-item").filter({ hasText: "notes.md" }),
  ).toHaveAttribute("data-active", "true");
});

test("#67 / #81 B several files each open in a tab; refused files show an error", async ({ page }) => {
  await withIpc(
    page,
    "ipc.seedMockFile('/tmp/kalamos-test/a.md', '# A'); ipc.seedMockFile('/tmp/kalamos-test/b.md', '# B');" +
      "await ipc.triggerMockOpenFiles({ paths: ['/tmp/kalamos-test/a.md', '/tmp/kalamos-test/b.md'], rejected: ['c.txt'] });",
  );
  await expect.poll(() => getDoc(page)).toBe("# B");
  await expect(page.getByTestId("tab")).toHaveText(["a.md", "b.md"]);
  await expect(page.getByTestId("status")).toContainText("無法開啟：c.txt");
});

test("#81 B unsaved untitled changes stay in their tab; the opened file gets a new one, without a prompt", async ({ page }) => {
  await withIpc(
    page,
    "ipc.seedMockFile('/tmp/kalamos-test/a.md', '# A'); window.__askCount = 0;" +
      "ipc.setMockDialogHandlers({ ask: () => { window.__askCount++; return false; } });",
  );
  await page.getByTestId("editor").click();
  await page.keyboard.type("草稿");
  await withIpc(page, "await ipc.triggerMockOpenFiles({ paths: ['/tmp/kalamos-test/a.md'] });");
  await expect.poll(() => getDoc(page)).toBe("# A");
  expect(await page.evaluate(() => (window as unknown as { __askCount: number }).__askCount)).toBe(0);
  await expect(page.getByTestId("tab")).toHaveText(["未命名", "a.md"]);

  // Opening it again switches to its tab.
  await page.getByTestId("tab").first().click();
  await withIpc(page, "await ipc.triggerMockOpenFiles({ paths: ['/tmp/kalamos-test/a.md'] });");
  await expect(page.getByTestId("tab")).toHaveCount(2);
  await expect(page.getByTestId("tab").nth(1)).toHaveAttribute("data-active", "true");
});
