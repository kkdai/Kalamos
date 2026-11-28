import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames } from "./helpers";

/**
 * #145: External file change detection (auto-reload clean file, conflict banner
 * with paused autosave, external delete/rename banner, self-save non-false-positive,
 * pre-save defense, and Papyros / Melan / Nyx theme rendering).
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

async function runApp<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const main = await import("/src/main.ts" as string);
      const ipc = await import("/src/ipc.ts" as string);
      const a = main.getActiveApp();
      return new Function(
        "app",
        "ipc",
        "arg",
        `return (async () => { ${fn} })();`,
      )(a, ipc, arg);
    },
    { fn, arg },
  );
}

const banner = (page: Page) => page.getByTestId("external-change-banner");
const status = (page: Page) => page.getByTestId("status");

test("#145 AC1: clean open file auto-reloads on external modification and preserves cursor & scroll", async ({
  page,
}) => {
  const filePath = "/tmp/kalamos-test/e2e-clean.md";
  const initialLines = Array.from(
    { length: 120 },
    (_, i) => `第 ${i + 1} 行：初始內容`,
  );
  const updatedLines = Array.from(
    { length: 120 },
    (_, i) => `第 ${i + 1} 行：外部更新內容`,
  );

  await runApp(
    page,
    `ipc.seedMockFile(arg.filePath, arg.content);
     await app.openDocument(arg.filePath);`,
    { filePath, content: initialLines.join("\n\n") },
  );
  await expect.poll(() => getDoc(page)).toBe(initialLines.join("\n\n"));

  // Move cursor to line 51 (non-empty paragraph line) col 4 and scroll down
  await runApp(
    page,
    `const line = app.editor.view.state.doc.line(51);
     app.editor.setCursor(line.from + 4);
     app.editor.view.scrollDOM.scrollTop = 900;`,
  );
  await nextFrames(page, 3);
  const scrollBefore = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(500);

  // External modification + mock open-files-changed event
  await runApp(
    page,
    `ipc.seedMockFile(arg.filePath, arg.content);
     await ipc.triggerMockOpenFilesChanged([arg.filePath]);`,
    { filePath, content: updatedLines.join("\n\n") },
  );

  await expect.poll(() => getDoc(page)).toBe(updatedLines.join("\n\n"));
  await expect(status(page)).toHaveText("已從磁碟重新載入");
  await expect(banner(page)).toHaveAttribute("data-visible", "false");

  const cursorAfter = await runApp<{ line: number; col: number }>(
    page,
    `const state = app.editor.view.state;
     const pos = state.selection.main.head;
     const l = state.doc.lineAt(pos);
     return { line: l.number, col: pos - l.from };`,
  );
  expect(cursorAfter).toEqual({ line: 51, col: 4 });

  await nextFrames(page, 2);
  const scrollAfter = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(8);
});

test("#145 AC2: dirty file conflict shows banner, pauses autosave, and both choices work", async ({
  page,
}) => {
  const filePath = "/tmp/kalamos-test/e2e-conflict.md";
  await runApp(
    page,
    `ipc.seedMockFile(arg.filePath, '# 原始標題');
     await app.openDocument(arg.filePath);`,
    { filePath },
  );

  // Make a local edit, then immediately simulate external modification before autosave
  await runApp(
    page,
    `const view = app.editor.view;
     view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n本機未儲存內容' }, userEvent: 'input.type' });
     ipc.seedMockFile(arg.filePath, '# 外部修改版本');
     await ipc.triggerMockOpenFilesChanged([arg.filePath]);`,
    { filePath },
  );

  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  await expect(banner(page)).toHaveAttribute("data-kind", "conflict");

  // Pressing Cmd+S while in conflict must NOT silently overwrite disk
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+s`);
  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  expect(
    await runApp<string>(page, "return ipc.readMockFile(arg);", filePath),
  ).toBe("# 外部修改版本");

  // Choice A: Keep My Version (Overwrite Disk)
  await page.getByTestId("external-change-keep-mine").click();
  await expect(banner(page)).toHaveAttribute("data-visible", "false");
  await expect
    .poll(() => runApp<string>(page, "return ipc.readMockFile(arg);", filePath))
    .toBe("# 原始標題\n本機未儲存內容");

  // Trigger a second conflict and choose Choice B: Load Disk Version
  await runApp(
    page,
    `const view = app.editor.view;
     view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n將被捨棄的變更' }, userEvent: 'input.type' });
     ipc.seedMockFile(arg.filePath, '# 磁碟最終版本');
     await ipc.triggerMockFsChanged({ root: '/tmp/kalamos-test', paths: [arg.filePath] });`,
    { filePath },
  );
  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  await expect(banner(page)).toHaveAttribute("data-kind", "conflict");

  await page.getByTestId("external-change-load-disk").click();
  await expect(banner(page)).toHaveAttribute("data-visible", "false");
  await expect.poll(() => getDoc(page)).toBe("# 磁碟最終版本");
  await expect(status(page)).toHaveText("已從磁碟重新載入");
});

test("#145 AC3: external delete / rename shows missing banner without losing content; recreate and Save As both work", async ({
  page,
}) => {
  const filePath = "/tmp/kalamos-test/e2e-deleted.md";
  await runApp(
    page,
    `ipc.seedMockFile(arg.filePath, '# 重要筆記');
     await app.openDocument(arg.filePath);
     ipc.deleteMockFile(arg.filePath);
     await ipc.triggerMockOpenFilesChanged([arg.filePath]);`,
    { filePath },
  );

  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  await expect(banner(page)).toHaveAttribute("data-kind", "missing");
  await expect.poll(() => getDoc(page)).toBe("# 重要筆記");

  // Recreate at original path
  await page.getByTestId("external-change-recreate").click();
  await expect(banner(page)).toHaveAttribute("data-visible", "false");
  await expect
    .poll(() => runApp<string>(page, "return ipc.readMockFile(arg);", filePath))
    .toBe("# 重要筆記");

  // External rename away -> missing banner, then Save As
  const newPath = "/tmp/kalamos-test/e2e-saved-as.md";
  await runApp(
    page,
    `await ipc.renamePath(arg.filePath, '/tmp/kalamos-test/e2e-moved.md');
     await ipc.triggerMockOpenFilesChanged([arg.filePath]);
     ipc.setMockDialogHandlers({ save: () => arg.newPath });`,
    { filePath, newPath },
  );
  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  await expect(banner(page)).toHaveAttribute("data-kind", "missing");

  await page.getByTestId("external-change-save-as").click();
  await expect(banner(page)).toHaveAttribute("data-visible", "false");
  await expect
    .poll(() => runApp<string>(page, "return ipc.readMockFile(arg);", newPath))
    .toBe("# 重要筆記");
  expect(
    await runApp<string | undefined>(
      page,
      "return ipc.readMockFile(arg);",
      filePath,
    ),
  ).toBeUndefined();
});

test("#145 AC4 & pre-save defense: self-save does not trigger false positive, stealth external edit is caught before overwrite", async ({
  page,
}) => {
  const filePath = "/tmp/kalamos-test/e2e-self-and-guard.md";
  await runApp(
    page,
    `ipc.seedMockFile(arg.filePath, '# 開始');
     await app.openDocument(arg.filePath);
     const view = app.editor.view;
     view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n自己存檔' }, userEvent: 'input.type' });`,
    { filePath },
  );
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+s`);
  await expect
    .poll(() => runApp<string>(page, "return ipc.readMockFile(arg);", filePath))
    .toBe("# 開始\n自己存檔");

  // Delayed watch event from self-save does not show banner or reload message
  await runApp(page, "await ipc.triggerMockOpenFilesChanged([arg]);", filePath);
  await expect(banner(page)).toHaveAttribute("data-visible", "false");
  await expect(status(page)).toHaveText("");

  // Stealth external edit (no watch event) + local edit + Cmd+S -> caught by pre-save defense
  await runApp(
    page,
    `const view = app.editor.view;
     view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n差點覆寫' }, userEvent: 'input.type' });
     ipc.seedMockFile(arg, '# 靜默外部修改');`,
    filePath,
  );
  await page.keyboard.press(`${MOD}+s`);
  await expect(banner(page)).toHaveAttribute("data-visible", "true");
  await expect(banner(page)).toHaveAttribute("data-kind", "conflict");
  expect(
    await runApp<string>(page, "return ipc.readMockFile(arg);", filePath),
  ).toBe("# 靜默外部修改");
});

const THEMES = [
  { name: "papyros", theme: "papyros", scheme: "light" },
  { name: "melan", theme: "melan", scheme: "dark" },
  { name: "nyx", theme: "nyx", scheme: "dark" },
] as const;

for (const look of THEMES) {
  test(`#145 banner visual check — ${look.name}`, async ({ page }) => {
    const shotsDir = process.env.KALAMOS_SHOTS_145_DIR
      ? resolve(process.env.KALAMOS_SHOTS_145_DIR)
      : resolve("test-results/shots-145");
    mkdirSync(shotsDir, { recursive: true });

    await page.emulateMedia({ colorScheme: look.scheme });
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
    }, look.theme);

    const fileA = "/tmp/kalamos-test/article.md";
    const fileB = "/tmp/kalamos-test/deleted-note.md";
    await runApp(
      page,
      `ipc.seedMockFile(arg.fileA, '# 技術文章草稿\\n\\n這是一段正在編輯的 Markdown 內容，支援 **粗體** 與 \`code\`。');
       ipc.seedMockFile(arg.fileB, '# 已被外部移除的筆記\\n\\n內容依然安全保留在編輯器中。');
       await app.openDocument(arg.fileA);
       const view = app.editor.view;
       view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n本機尚未儲存的段落。' }, userEvent: 'input.type' });
       ipc.seedMockFile(arg.fileA, '# 外部已更新的版本');
       await ipc.triggerMockOpenFilesChanged([arg.fileA]);
       await app.openDocument(arg.fileB);
       ipc.deleteMockFile(arg.fileB);
       await ipc.triggerMockOpenFilesChanged([arg.fileB]);
       app.activateTab(app.getTabs()[0].id);`,
      { fileA, fileB },
    );

    await expect(banner(page)).toHaveAttribute("data-visible", "true");
    await expect(banner(page)).toHaveAttribute("data-kind", "conflict");
    await nextFrames(page, 3);
    await page.screenshot({
      path: resolve(shotsDir, `145-conflict-${look.name}.png`),
      clip: { x: 0, y: 0, width: 1200, height: 320 },
    });

    // Switch to missing-file tab and capture screenshot
    await runApp(page, "app.activateTab(app.getTabs()[1].id);");
    await expect(banner(page)).toHaveAttribute("data-visible", "true");
    await expect(banner(page)).toHaveAttribute("data-kind", "missing");
    await nextFrames(page, 3);
    await page.screenshot({
      path: resolve(shotsDir, `145-missing-${look.name}.png`),
      clip: { x: 0, y: 0, width: 1200, height: 320 },
    });
  });
}
