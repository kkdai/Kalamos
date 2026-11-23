import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentSummary } from "../shared/api";
import {
  appendText,
  databaseDocument,
  documentFrom,
  downloadMarkdown,
  editor,
  expect,
  fileOperation,
  openDocument,
  pickMarkdown,
  png,
  seedDocument,
  setPath,
  start,
  status,
  test,
  waitForApi,
} from "./fixtures";

test("WEB-01: import exact UTF-8 bytes, edit, save, reopen in a fresh context, and download", async ({
  page,
  browser,
  request,
  name,
}, testInfo) => {
  const filename = `${name}.md`;
  const diskPath = testInfo.outputPath(filename);
  const original = "\uFEFF# 中英筆記\r\n\r\nHello 繁體中文";
  const edited = `${original}，已修改。`;
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(diskPath, original);

  await start(page);
  const created = waitForApi(page, "POST", "documents");
  await pickMarkdown(page, diskPath);
  const doc = await documentFrom(await created);
  expect(doc.path).toBe(filename);
  expect(doc.content).toBe(original);
  await expect(editor(page)).toContainText("Hello 繁體中文");
  expect(await downloadMarkdown(page)).toEqual({
    name: filename,
    bytes: Buffer.from(original),
  });

  await appendText(page, "，已修改。");
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  const saved = await documentFrom(await saving);
  expect(saved.revision).toBeGreaterThan(doc.revision);
  expect((await databaseDocument(request, doc.id)).content).toBe(edited);

  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await start(reopened);
    await openDocument(reopened, filename);
    await expect(editor(reopened)).toContainText("Hello 繁體中文，已修改。");
    expect(await downloadMarkdown(reopened)).toEqual({
      name: filename,
      bytes: Buffer.from(edited),
    });
  } finally {
    await fresh.close();
  }
  expect(await readFile(diskPath)).toEqual(Buffer.from(original));
});

test("WEB-01: cancel or reject an invalid UTF-8 import without replacing the open document", async ({
  page,
  name,
}) => {
  const filename = `${name}.md`;
  const original = Buffer.from("目前的文件\n");
  await start(page);
  const created = waitForApi(page, "POST", "documents");
  await pickMarkdown(page, {
    name: filename,
    mimeType: "text/markdown",
    buffer: original,
  });
  await documentFrom(await created);
  await expect(editor(page)).toContainText("目前的文件");

  const chooser = page.waitForEvent("filechooser");
  await page.locator("#import-markdown").click();
  await (await chooser).setFiles([]);
  expect((await downloadMarkdown(page)).bytes).toEqual(original);

  await pickMarkdown(page, {
    name: `${name}-invalid.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(status(page)).toContainText(/UTF-8|已匯入 0 份文件/);
  expect(await downloadMarkdown(page)).toEqual({
    name: filename,
    bytes: original,
  });
});

test("WEB-03: folder import, missing image, and relative attachment survive a clean reopen", async ({
  page,
  browser,
  request,
  name,
}, testInfo) => {
  const folder = testInfo.outputPath(name);
  const path = `${name}/nested/article.md`;
  const content =
    "# 圖片\n\n![Verified image](assets/example.png)\n\n![Missing image](assets/missing.png)\n";
  await mkdir(join(folder, "nested"), { recursive: true });
  await writeFile(join(folder, "nested", "article.md"), content);
  const pngFile = testInfo.outputPath("example.png");
  await writeFile(pngFile, png);

  await start(page);
  const created = waitForApi(page, "POST", "documents");
  const folderChooser = page.waitForEvent("filechooser");
  await fileOperation(page, "import-folder");
  await (await folderChooser).setFiles(folder);
  const doc = await documentFrom(await created);
  expect(doc).toMatchObject({ path, content });
  await expect(
    page.getByTestId("image-fallback").filter({ hasText: "Missing image" }),
  ).toContainText("assets/missing.png");
  await expect(
    page.getByTestId("image-fallback").filter({ hasText: "Verified image" }),
  ).toContainText("assets/example.png");

  const attachmentChooser = page.waitForEvent("filechooser");
  await fileOperation(page, "import-attachment");
  await (await attachmentChooser).setFiles(pngFile);
  const assetPath = `${name}/nested/assets/example.png`;
  await expect(page.locator("#document-path")).toHaveValue(assetPath);
  await setPath(page, assetPath);
  const image = page.getByRole("img", { name: "Verified image" });
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  const stored = await request.get("/api/assets", {
    params: { path: assetPath },
  });
  await expect(stored).toBeOK();
  expect(await stored.body()).toEqual(png);
  expect((await databaseDocument(request, doc.id)).content).toBe(content);

  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await start(reopened);
    await openDocument(reopened, path);
    await expect(
      reopened.getByRole("img", { name: "Verified image" }),
    ).toHaveJSProperty("naturalWidth", 1);
    await expect(
      reopened
        .getByTestId("image-fallback")
        .filter({ hasText: "Missing image" }),
    ).toContainText("assets/missing.png");
  } finally {
    await fresh.close();
  }
});

test("WEB-04: create, find by content, move, trash, and restore", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}/new.md`;
  const moved = `${name}/nested/moved.md`;
  await start(page);
  const creating = waitForApi(page, "POST", "documents");
  await page.locator("#new-document").click();
  await setPath(page, path);
  const doc = await documentFrom(await creating);
  expect(doc).toMatchObject({ path, content: "", deleted: false });

  const text = `${name} 從內容搜尋`;
  await appendText(page, text);
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  await documentFrom(await saving);
  const results = await request.get("/api/documents", { params: { q: text } });
  await expect(results).toBeOK();
  expect(
    ((await results.json()) as DocumentSummary[]).map(({ id }) => id),
  ).toEqual([doc.id]);
  await page.locator("#workspace-search").fill(text);
  await expect(
    page
      .locator("#workspace-documents")
      .getByRole("button", { name: path, exact: true }),
  ).toBeVisible();

  const moving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await fileOperation(page, "rename-document");
  await setPath(page, moved);
  expect(await documentFrom(await moving)).toMatchObject({
    path: moved,
    content: text,
  });

  const trashing = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await fileOperation(page, "trash-document");
  await page.locator("#decision-confirm").click();
  expect(await documentFrom(await trashing)).toMatchObject({ deleted: true });
  await page.locator("#workspace-search").clear();
  await page.locator('#workspace-view [data-view="trash"]').click();
  const restoring = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page
    .locator("#workspace-documents")
    .getByRole("button", { name: `還原 ${moved}`, exact: true })
    .click();
  expect(await documentFrom(await restoring)).toMatchObject({
    path: moved,
    content: text,
    deleted: false,
  });
  await openDocument(page, moved);
  await expect(editor(page)).toContainText(text);
});

test("WEB-04: two tabs reject a stale save without overwriting the database or losing the stale edit", async ({
  page,
  context,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const original = "Shared base";
  await start(page);
  const creating = waitForApi(page, "POST", "documents");
  await pickMarkdown(page, {
    name: path,
    mimeType: "text/markdown",
    buffer: Buffer.from(original),
  });
  const doc = await documentFrom(await creating);
  await expect(editor(page)).toContainText(original);
  const second = await context.newPage();
  await start(second);
  await openDocument(second, path);
  await expect(editor(second)).toContainText(original);

  await appendText(page, " — first tab");
  const firstSave = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  const winner = await documentFrom(await firstSave);
  expect(winner.content).toBe(`${original} — first tab`);
  await expect(status(page)).toHaveText("已儲存");

  await appendText(second, " — second tab");
  const staleSave = waitForApi(second, "PATCH", `documents/${doc.id}`);
  await second.locator("#save-document").click();
  expect((await staleSave).status()).toBe(409);
  await expect(status(second)).toContainText("版本不一致");
  await expect(editor(second)).toContainText("second tab");
  expect((await databaseDocument(request, doc.id)).content).toBe(
    winner.content,
  );
  expect((await downloadMarkdown(second)).bytes).toEqual(
    Buffer.from(`${original} — second tab`),
  );
});

test("WEB-01: distinguish the same file name in different imported subfolders", async ({
  page,
  request,
  name,
}, testInfo) => {
  const folder = testInfo.outputPath(name);
  for (const dir of ["first", "second"]) {
    await mkdir(join(folder, dir), { recursive: true });
    await writeFile(join(folder, dir, "same.md"), `# ${dir} 中文`);
  }
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await fileOperation(page, "import-folder");
  await (await chooser).setFiles(folder);
  await expect(status(page)).toHaveText("已匯入 2 份 Markdown");
  const response = await request.get("/api/documents", { params: { q: name } });
  await expect(response).toBeOK();
  const documents = (await response.json()) as DocumentSummary[];
  expect(documents.map(({ path }) => path)).toEqual([
    `${name}/first/same.md`,
    `${name}/second/same.md`,
  ]);
  expect((await databaseDocument(request, documents[0].id)).content).toBe(
    "# first 中文",
  );
  expect((await databaseDocument(request, documents[1].id)).content).toBe(
    "# second 中文",
  );
});

test("WEB-04: Quick Open switches sessions without merging their undo histories", async ({
  page,
  request,
  name,
}) => {
  const first = `${name}-first.md`;
  const second = `${name}-second.md`;
  await seedDocument(request, first, "First");
  await seedDocument(request, second, "Second");
  await start(page);
  await openDocument(page, first);
  await appendText(page, " edit A");
  await page.locator("#quick-open").click();
  await page.locator("#quick-search").fill(`${name}-second`);
  await page.locator("#quick-search").press("Enter");
  await expect(editor(page)).toHaveText("Second");
  await appendText(page, " edit B");
  const tabs = page.locator("#open-documents");
  await tabs.getByRole("button", { name: `${first} •`, exact: true }).click();
  await expect(editor(page)).toHaveText("First edit A");
  await editor(page).press("ControlOrMeta+z");
  await expect(editor(page)).toHaveText("First");
  await tabs.getByRole("button", { name: `${second} •`, exact: true }).click();
  await expect(editor(page)).toHaveText("Second edit B");
});

test("WEB-04: a delayed successful save cannot mark newer edits as saved", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, "Original");
  await start(page);
  await openDocument(page, path);
  let release = () => {};
  let committed = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observedCommit = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const endpoint = `**/api/documents/${doc.id}`;
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    committed();
    await hold;
    await route.fulfill({ response });
  });
  try {
    await appendText(page, " first");
    const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
    await page.locator("#save-document").click();
    await observedCommit;
    await appendText(page, " second");
    release();
    expect((await documentFrom(await saving)).content).toBe("Original first");
    await expect(status(page)).toHaveText("尚未儲存");
    expect((await downloadMarkdown(page)).bytes).toEqual(
      Buffer.from("Original first second"),
    );
  } finally {
    release();
    await page.unroute(endpoint);
  }
  const retry = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  expect((await documentFrom(await retry)).content).toBe(
    "Original first second",
  );
  await expect(status(page)).toHaveText("已儲存");
});
