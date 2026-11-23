import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  appendText,
  databaseDocument,
  documentFrom,
  editor,
  expect,
  fileOperation,
  openDocument,
  seedDocument,
  setPath,
  start,
  status,
  test,
  waitForApi,
} from "./fixtures";

test("auto-save waits for the last edit and never marks a newer pending edit as saved", async ({
  page,
  request,
  name,
}) => {
  await expect(
    await request.post("/api/settings", { data: { autosave: true } }),
  ).toBeOK();
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, "Original");
  await page.clock.install();
  await start(page);
  await openDocument(page, path);
  await appendText(page, " first");
  await page.clock.runFor(600);
  await appendText(page, " second");
  await page.clock.runFor(500);
  expect((await databaseDocument(request, doc.id)).content).toBe("Original");
  await expect(status(page)).toHaveText("尚未儲存");
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.clock.runFor(550);
  expect((await documentFrom(await saving)).content).toBe(
    "Original first second",
  );
  await expect(status(page)).toHaveText("已儲存");
});

test("a newer database version does not erase another tab's saved browser draft", async ({
  page,
  context,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const recoveredPath = `${name}-recovered.md`;
  const doc = await seedDocument(request, path, "Original");
  await start(page);
  await openDocument(page, path);
  const stale = await context.newPage();
  await start(stale);
  await openDocument(stale, path);
  await appendText(page, " saved first");
  await appendText(stale, " browser draft");
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  expect((await documentFrom(await saving)).content).toBe(
    "Original saved first",
  );
  await start(stale);
  await openDocument(stale, path);
  await expect(stale.locator("#decision-message")).toContainText(
    "已有較新版本",
  );
  await stale.locator("#decision-confirm").click();
  const recovered = waitForApi(stale, "POST", "documents");
  await setPath(stale, recoveredPath);
  expect(await documentFrom(await recovered)).toMatchObject({
    path: recoveredPath,
    content: "Original browser draft",
  });
  await expect(editor(stale)).toContainText("Original browser draft");
  expect((await databaseDocument(request, doc.id)).content).toBe(
    "Original saved first",
  );
});

test("tab navigation retains the caret and the menu opens the editor's in-document search", async ({
  page,
  request,
  name,
}) => {
  const first = `${name}-first.md`;
  const second = `${name}-second.md`;
  await seedDocument(request, first, "alpha\nbeta\n");
  await seedDocument(request, second, "gamma");
  await start(page);
  await openDocument(page, first);
  await editor(page).locator(".cm-line").filter({ hasText: "beta" }).click();
  await page.keyboard.press("End");
  await openDocument(page, second);
  await page
    .locator("#open-documents")
    .getByRole("button", { name: first, exact: true })
    .click();
  await editor(page).press("!");
  await expect(editor(page)).toContainText("beta!");
  await fileOperation(page, "find-document");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  await input.fill("alpha");
  await input.press("Enter");
  await expect(editor(page).locator(".cm-searchMatch-selected")).toHaveText(
    "alpha",
  );
});

test("only explicit reimport updates the stored document without touching the local file", async ({
  page,
  request,
  name,
}, testInfo) => {
  const doc = await seedDocument(request, `${name}.md`, "Database original");
  await mkdir(testInfo.outputDir, { recursive: true });
  const filename = testInfo.outputPath(`${name}-source.md`);
  const replacement = "\uFEFF# 本機來源\r\n\r\n更新內容";
  await writeFile(filename, replacement);
  await start(page);
  await openDocument(page, doc.path);

  async function selectReplacement() {
    const chooser = page.waitForEvent("filechooser");
    await fileOperation(page, "reimport-document");
    await (await chooser).setFiles(filename);
    await expect(page.locator("#decision-message")).toContainText(doc.path);
  }

  await selectReplacement();
  await page
    .locator("#decision-dialog")
    .getByRole("button", { name: "取消" })
    .click();
  expect((await databaseDocument(request, doc.id)).content).toBe(doc.content);
  await selectReplacement();
  const saved = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#decision-confirm").click();
  expect(await documentFrom(await saved)).toMatchObject({
    id: doc.id,
    path: doc.path,
    content: replacement,
  });
  await expect(status(page)).toHaveText("已重新匯入");
  await expect(editor(page)).toContainText("更新內容");
  expect(await readFile(filename, "utf8")).toBe(replacement);

  await appendText(page, "尚未儲存");
  await fileOperation(page, "reimport-document");
  await expect(status(page)).toContainText("請先儲存目前編輯");
  await expect(editor(page)).toContainText("尚未儲存");
  expect((await databaseDocument(request, doc.id)).content).toBe(replacement);

  await fileOperation(page, "save-copy");
  const copySaved = waitForApi(page, "POST", "documents");
  const copyPath = `${name}-copy.md`;
  await setPath(page, copyPath);
  expect(await documentFrom(await copySaved)).toMatchObject({
    path: copyPath,
    content: `${replacement}尚未儲存`,
  });
  expect((await databaseDocument(request, doc.id)).content).toBe(replacement);
});
