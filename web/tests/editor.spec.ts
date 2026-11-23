import {
  databaseDocument,
  documentFrom,
  editor,
  expect,
  openDocument,
  seedDocument,
  start,
  test,
  waitForApi,
} from "./fixtures";

const markdown = [
  "# Render sample",
  "",
  "中文English混排，**粗體**。",
  "",
  "- [ ] Task check",
  "",
  "| Name | Count |",
  "| --- | --- |",
  "| 蘋果 | 2 |",
  "",
  "## Equation",
  "",
  "$x^2$",
  "",
  "```mermaid",
  "flowchart TD",
  "  Start --> Finish",
  "```",
  "",
  "```flow",
  "start=>start: Begin",
  "end=>end: End",
  "start->end",
  "```",
  "",
  "```sequence",
  "Alice->Bob: Local message",
  "```",
  "",
  "```flow",
  "not valid flow syntax",
  "```",
].join("\n");

test("WEB-02: edit GFM, jump with the outline, and render math and all diagram syntaxes offline", async ({
  page,
  context,
  request,
  name,
  baseURL,
}) => {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === baseURL) return route.continue();
    external.push(url);
    return route.abort();
  });
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, markdown);
  await start(page);
  await openDocument(page, path);
  await expect(editor(page).locator(".k-strong")).toHaveText("粗體");
  await expect(page.getByTestId("math-inline").locator("svg")).toBeVisible();
  for (const [kind, label] of [
    ["mermaid", "Finish"],
    ["flow", "Begin"],
    ["sequence", "Local message"],
  ]) {
    const svg = page.locator(`[data-kind="${kind}"] .k-diagram-svg svg`);
    await expect(svg).toBeVisible();
    await expect(svg).toContainText(label);
  }
  await expect(page.getByTestId("diagram-error")).toHaveAttribute(
    "data-line",
    "1",
  );

  const task = editor(page).getByRole("checkbox");
  await task.check();
  await expect(task).toBeChecked();
  const cell = page
    .getByTestId("table-widget")
    .locator('[data-row="1"][data-col="1"] .k-table-cell-content');
  await cell.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("3");
  await expect(cell).toHaveText("23");

  await page.locator("#workspace-search").clear();
  await page.locator('#workspace-view [data-view="outline"]').click();
  const outline = page.locator("#workspace-documents").getByRole("button");
  await expect(outline).toHaveText(["Render sample", "Equation"]);
  await page
    .locator("#workspace-documents")
    .getByRole("button", { name: "Equation", exact: true })
    .click();
  await expect(outline.nth(1)).toHaveAttribute("aria-current", "true");
  const source = page.locator("#source-mode");
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect(editor(page)).toContainText("## Equation");
  await expect(page.getByTestId("math-inline")).toHaveCount(0);
  await expect(page.getByTestId("diagram")).toHaveCount(0);
  // The outline put the cursor at the heading. Toggling source mode must not move it.
  await editor(page).press("End");
  await page.keyboard.insertText(" updated");
  await expect(outline).toHaveText(["Render sample", "Equation updated"]);
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("math-inline").locator("svg")).toBeVisible();

  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  await documentFrom(await saving);
  const saved = await databaseDocument(request, doc.id);
  expect(saved.content).toContain("- [x] Task check");
  expect(saved.content).toMatch(/\|\s*蘋果\s*\|\s*23\s*\|/);
  expect(saved.content).toContain("## Equation updated");
  expect(external).toEqual([]);
});

test("inline LaTeX renders in table cells and remains editable as Markdown", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  await seedDocument(
    request,
    path,
    [
      "# Research note",
      "",
      "| 符號 | 意義與形狀 |",
      "| --- | --- |",
      "| $d,m,k$ | 可學習權重，$\\mathbb R^d$，從 $1\\ldots m$ 選取 |",
    ].join("\n"),
  );
  await start(page);
  await openDocument(page, path);
  const table = page.getByTestId("table-widget");
  const formulas = table.getByTestId("math-inline").locator("svg");
  await expect(formulas).toHaveCount(3);
  const firstCell = table.locator(
    '[data-row="1"][data-col="0"] .k-table-cell-content',
  );
  await firstCell.click();
  await expect(firstCell).toHaveText("$d,m,k$");
  await expect(formulas).toHaveCount(2);
  await page.locator("#source-mode").click();
  await expect(editor(page)).toContainText("$\\mathbb R^d$");
  await page.locator("#source-mode").click();
  await expect(formulas).toHaveCount(3);
});

test("WEB-05: match the desktop word count and retain writing modes and theme in a fresh context", async ({
  page,
  browser,
  request,
  name,
}) => {
  // Same input and expected reader-visible count as desktop tests/e2e/word-count.spec.ts.
  const content =
    "# 標題 Title\n\n中文English混排，**粗體** and more words.\n\n- item one\n";
  const path = `${name}.md`;
  await seedDocument(request, path, content);
  await start(page);
  await openDocument(page, path);
  const counter = page.getByTestId("word-count");
  await expect(counter).toHaveText("15 字");
  await editor(page).press("ControlOrMeta+a");
  await expect(counter).toHaveText("選取 15 / 15 字");
  await editor(page).press("ControlOrMeta+End");
  await page.keyboard.insertText("More");
  await expect(counter).toHaveText("16 字");
  await editor(page).press("ControlOrMeta+z");
  await expect(counter).toHaveText("15 字");
  const focusSave = waitForApi(page, "POST", "settings");
  await editor(page).press("F8");
  expect((await focusSave).ok()).toBe(true);
  await expect(page.locator(".cm-editor")).toHaveClass(/k-focus-mode/);
  const typewriterSave = waitForApi(page, "POST", "settings");
  await editor(page).press("F9");
  expect((await typewriterSave).ok()).toBe(true);
  await expect(page.locator(".cm-editor")).toHaveClass(/k-typewriter-mode/);

  await page.locator("#open-preferences").click();
  const preferences = page.locator("#preferences-dialog");
  await preferences.locator('select[name="theme"]').selectOption("melan");
  const prefsSave = waitForApi(page, "POST", "settings");
  await preferences.getByRole("button", { name: "套用", exact: true }).click();
  expect((await prefsSave).ok()).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "melan");

  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await start(reopened);
    await openDocument(reopened, path);
    await expect(reopened.locator("html")).toHaveAttribute(
      "data-theme",
      "melan",
    );
    await expect(reopened.locator(".cm-editor")).toHaveClass(/k-focus-mode/);
    await expect(reopened.locator(".cm-editor")).toHaveClass(
      /k-typewriter-mode/,
    );
    await expect(reopened.getByTestId("word-count")).toHaveText("15 字");
  } finally {
    await fresh.close();
  }
});
