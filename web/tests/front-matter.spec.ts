import {
  databaseDocument,
  editor,
  expect,
  openDocument,
  seedDocument,
  start,
  test,
  waitForApi,
} from "./fixtures";

const markdown = [
  "---",
  "# A comment that stays in the source",
  'title: "<strong>研究筆記</strong>"',
  "date: 2026-11-24",
  "tags: [Markdown, YAML]",
  "project:",
  "  public: false",
  "summary: |",
  "  第一行",
  "  第二行",
  "...",
  "",
  "# 正文",
  "",
  "---",
  "",
  "更多內容",
].join("\n");

test("render front matter as fields and edit its original YAML", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, markdown);
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  const card = content.getByTestId("front-matter-preview");
  await expect(card.locator("dt")).toHaveText([
    "title",
    "date",
    "tags",
    "project",
    "public",
    "summary",
  ]);
  await expect(card.getByText("<strong>研究筆記</strong>")).toBeVisible();
  await expect(card.locator("strong")).toHaveText("文件資訊");
  await expect(card.locator("li")).toHaveText(["Markdown", "YAML"]);
  await expect(card.locator("dd").nth(1)).toHaveText("2026-11-24");
  await expect(card.getByText("false", { exact: true })).toBeVisible();
  await expect(card.getByText("第一行 第二行")).toBeVisible();
  await expect(content.locator(".k-hr")).toHaveCount(1);
  expect(await databaseDocument(request, doc.id)).toMatchObject({
    content: markdown,
    revision: doc.revision,
  });

  await expect(card).not.toContainText("編輯 YAML");
  await card.click();
  await expect(card).toHaveCount(0);
  await expect(content).toBeFocused();
  await expect(content).toContainText("# A comment that stays in the source");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText("title: 更新後的標題");
  await content.getByText("更多內容", { exact: true }).click();
  await expect(card.getByText("更新後的標題", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "編輯文件資訊" }).press("Enter");
  await expect(card).toHaveCount(0);
  await page.locator("#workspace-search").click();
  await expect(card).toBeVisible();
  await content.getByText("更多內容", { exact: true }).click();

  const source = page.getByRole("button", { name: "原始碼" });
  await source.click();
  await expect(card).toHaveCount(0);
  await expect(content).toContainText("title: 更新後的標題");
  await expect(content).toContainText("tags: [Markdown, YAML]");
  await source.click();
  await expect(card).toBeVisible();

  const saved = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  expect((await saved).ok()).toBe(true);
  expect((await databaseDocument(request, doc.id)).content).toBe(
    markdown.replace(
      'title: "<strong>研究筆記</strong>"',
      "title: 更新後的標題",
    ),
  );
});

test("leave invalid YAML as editable source without affecting the body", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  await seedDocument(request, path, "---\ntags: [broken\n---\n\n# 正文\n");
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  await expect(content.getByTestId("front-matter-preview")).toHaveCount(0);
  await expect(content.locator(".k-frontmatter-line").nth(1)).toHaveText(
    "tags: [broken",
  );
  await expect(content.getByText("正文", { exact: true })).toBeVisible();
});
