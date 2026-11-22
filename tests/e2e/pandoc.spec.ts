import { expect, test } from "@playwright/test";
import { boot, getDoc, MOD, setDoc, withIpc } from "./helpers";

/** Issue #16: EX-02 export via Pandoc, EX-03 import (ipc mock stands in for pandoc). */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("#16 EX-02: Cmd+Opt+E → pick DOCX → save → status shows the exported file", async ({
  page,
}) => {
  await withIpc(
    page,
    "ipc.seedMockFile('/tmp/kalamos-test/Report.md', arg); ipc.setMockDialogHandlers({ save: () => '/tmp/kalamos-test/Report.docx' });",
    "# 標題\n\n- 清單\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![圖](img/a.png)\n",
  );
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    await main.getActiveApp().openDocument("/tmp/kalamos-test/Report.md");
  });
  await page.keyboard.press(`${MOD}+Alt+KeyE`);
  const picker = page.getByTestId("export-format-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".k-format-option")).toHaveCount(5);
  await page.getByTestId("export-format-docx").click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText(
    "已匯出 DOCX：/tmp/kalamos-test/Report.docx",
  );

  const jobs = await withIpc<
    Array<{ format: string; markdown: string; outPath: string }>
  >(page, "return ipc.getMockPandocExports();");
  expect(jobs).toHaveLength(1);
  expect(jobs[0].format).toBe("docx");
  expect(jobs[0].markdown).toContain("# 標題");
  expect(jobs[0].markdown).toContain("| 1 | 2 |");
  expect(jobs[0].markdown).toContain("![圖](/tmp/kalamos-test/img/a.png)");
});

test("#16 EX-02: without Pandoc the install hint is shown and no picker opens", async ({
  page,
}) => {
  await setDoc(page, "# a");
  await withIpc(page, "ipc.setMockPandocAvailable(false);");
  await page.keyboard.press(`${MOD}+Alt+KeyE`);
  await expect(page.getByTestId("status")).toHaveText(
    "找不到 Pandoc：請先安裝（brew install pandoc）",
  );
  await expect(page.getByTestId("export-format-picker")).toHaveCount(0);
});

test("#16 EX-03: Cmd+Opt+I imports a DOCX as a new untitled document with the converted text", async ({
  page,
}) => {
  await setDoc(page, "原本的內容");
  await withIpc(
    page,
    "ipc.setMockDialogHandlers({ open: () => '/tmp/kalamos-test/報告.docx' });",
  );
  await page.keyboard.press(`${MOD}+Alt+KeyI`);
  await expect(page.getByTestId("status")).toHaveText("已匯入：報告.docx");
  const canned = await withIpc<string>(
    page,
    "return ipc.MOCK_PANDOC_IMPORT_MARKDOWN;",
  );
  expect(await getDoc(page)).toBe(canned);
  // Heading levels survive: H1–H3 render as headings in the editor.
  await expect(
    page.locator(".cm-content .cm-line").filter({ hasText: "第三層" }),
  ).toHaveCount(1);
  const state = await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    const app = main.getActiveApp();
    return { path: app.getCurrentPath(), dirty: app.editor.isDirty() };
  });
  expect(state).toEqual({ path: null, dirty: true });
});
