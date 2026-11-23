import type { BrowserContext, Page } from "@playwright/test";
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

function line(page: Page, text: string) {
  return editor(page).locator(".cm-line").filter({ hasText: text });
}

function caretLine(page: Page) {
  return editor(page).evaluate(() =>
    window
      .getSelection()
      ?.anchorNode?.parentElement?.closest(".cm-line")
      ?.textContent?.trim(),
  );
}

async function preferences(page: Page) {
  await page
    .getByRole("button", { name: "偏好設定", exact: true })
    .press("Enter");
  const dialog = page.getByRole("dialog", { name: "偏好設定", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function applyPreferences(page: Page) {
  const saved = waitForApi(page, "POST", "settings");
  await page.getByRole("button", { name: "套用", exact: true }).click();
  expect((await saved).ok()).toBe(true);
}

async function watchExternalRequests(
  context: BrowserContext,
  baseURL: string | undefined,
) {
  const external: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === baseURL) return route.continue();
    external.push(url);
    return route.abort();
  });
  return external;
}

test("WEB-02: preview CJK italic, YAML front matter, footnotes and a live TOC", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  await seedDocument(
    request,
    path,
    [
      "---",
      "title: 部落格文章",
      "tags: [a]",
      "---",
      "",
      "[TOC]",
      "",
      "# 第一章",
      "",
      "中文*斜體*接續，Kalamos 註腳[^1] 範例。",
      "",
      "Missing[^nope] ref",
      "",
      "[^1]: 這是註腳內容 **粗體**。",
      "",
      "## 結尾",
    ].join("\n"),
  );
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  await expect(content.locator(".k-em")).toHaveText("斜體");
  await expect(content.locator(".k-em")).toHaveCSS("font-style", "italic");
  await expect(content.locator(".k-frontmatter-line")).toHaveCount(4);
  await expect(content.locator(".k-frontmatter-line").nth(1)).toHaveText(
    "title: 部落格文章",
  );
  await expect(content.locator(".k-hr")).toHaveCount(0);

  const reference = content.locator(".k-footnote-ref");
  await expect(reference).toHaveText("1");
  await expect(line(page, "Missing[^nope] ref")).toBeVisible();
  await reference.hover();
  await expect(page.getByTestId("footnote-tooltip")).toContainText(
    "這是註腳內容 **粗體**。",
  );
  await reference.click();
  await expect.poll(() => caretLine(page)).toContain("這是註腳內容");

  const links = content.locator(".k-toc").getByRole("link");
  await expect(links).toHaveText(["第一章", "結尾"]);
  await content.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("## 新增標題");
  await expect(links).toHaveText(["第一章", "結尾", "新增標題"]);
  await links.getByText("新增標題", { exact: true }).click();
  await expect.poll(() => caretLine(page)).toContain("新增標題");
});

test("WEB-02/04: follow an in-document heading anchor and a relative Markdown link with a heading", async ({
  page,
  request,
  name,
}) => {
  const source = `${name}/notes/start.md`;
  const target = `${name}/reference/guide.md`;
  const filler = Array.from({ length: 60 }, (_, i) => `填充段落 ${i + 1}`).join(
    "\n\n",
  );
  await seedDocument(
    request,
    source,
    [
      "# 開頭",
      "",
      "[跳到結尾](#結尾-end)",
      "",
      filler,
      "",
      "## 結尾 End",
      "",
      "[開啟指南](../reference/guide.md#細節-details)",
    ].join("\n"),
  );
  await seedDocument(
    request,
    target,
    `# 指南\n\n${filler}\n\n## 細節 Details\n\n真正的指南`,
  );
  await seedDocument(
    request,
    `${name}/notes/guide.md`,
    "## 細節 Details\n\n同名的其他文件",
  );
  await start(page);
  await openDocument(page, source);
  const content = editor(page);
  const link = content.locator(".k-link");
  await link
    .getByText("跳到結尾", { exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(line(page, "結尾 End")).toBeInViewport();
  await expect.poll(() => caretLine(page)).toContain("結尾 End");
  await link
    .getByText("開啟指南", { exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(
    page.locator("#open-documents").getByTitle(target, { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(line(page, "細節 Details")).toBeInViewport();
  await expect.poll(() => caretLine(page)).toContain("細節 Details");
  await expect(line(page, "真正的指南")).toBeInViewport();
});

test("WEB-02: auto-pair follows preferences and Chromium composition commits CJK punctuation once", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, "他說");
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  await content.press("ControlOrMeta+End");
  await page.keyboard.type("(");
  await expect(content).toHaveText("他說()");
  await page.keyboard.type("a)");
  await expect(content).toHaveText("他說(a)");
  await page.keyboard.type(" *");
  await expect(content).toHaveText("他說(a) *");
  await page.keyboard.press("Backspace");

  const panel = await preferences(page);
  await panel.getByLabel("自動配對括號及引號").uncheck();
  await panel.getByLabel("自動配對 Markdown 符號").check();
  await applyPreferences(page);
  await content.press("ControlOrMeta+End");
  await page.keyboard.type("(");
  await expect(content).toHaveText("他說(a) (");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("*");
  await expect(content).toHaveText("他說(a) **");
  await page.keyboard.type("x*");
  await expect(content).toHaveText("他說(a) *x*");

  await preferences(page);
  await panel.getByLabel("自動配對括號及引號").check();
  await applyPreferences(page);
  await content.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("他說");
  const cdp = await page.context().newCDPSession(page);
  // Chromium's composition path, not a physical IME or its candidate window.
  await cdp.send("Input.imeSetComposition", {
    text: "「",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect(line(page, "他說「")).toBeVisible();
  await cdp.send("Input.insertText", { text: "「" });
  await cdp.send("Input.imeSetComposition", {
    text: "hao",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await expect(line(page, "他說「hao")).toBeVisible();
  await cdp.send("Input.insertText", { text: "好" });
  await cdp.send("Input.insertText", { text: "」" });
  await expect(line(page, "他說「")).toHaveText("他說「好」");
  await cdp.detach();

  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.getByRole("button", { name: "儲存", exact: true }).press("Enter");
  await documentFrom(await saving);
  expect((await databaseDocument(request, doc.id)).content).toBe(
    "他說(a) *x*\n他說「好」",
  );
});

test("WEB-02: emoji suggestions and shortcodes need no external requests", async ({
  page,
  context,
  baseURL,
  request,
  name,
}) => {
  const external = await watchExternalRequests(context, baseURL);
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, "今天 ");
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  await content.press("ControlOrMeta+End");
  await page.keyboard.type(":smile");
  const popup = page.locator(".cm-tooltip-autocomplete");
  const candidate = popup.getByRole("option").filter({ hasText: ":smile:" });
  await expect(candidate.getByTestId("emoji-option")).toHaveText("😄");
  await candidate.click();
  await expect(popup).toBeHidden();
  await page.keyboard.type(" :+1:");
  await expect(content).toHaveText("今天 😄 👍");
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await documentFrom(await saving);
  expect((await databaseDocument(request, doc.id)).content).toBe("今天 😄 👍");
  expect(external).toEqual([]);
});

test("WEB-02: show code highlighting and line numbers, edit block math, and number AMS align rows offline", async ({
  page,
  context,
  baseURL,
  request,
  name,
}) => {
  const external = await watchExternalRequests(context, baseURL);
  const path = `${name}.md`;
  const doc = await seedDocument(
    request,
    path,
    [
      "# 物理公式推導",
      "",
      "```js",
      "const a = 1; // note",
      "let b = 2;",
      "```",
      "",
      "$$",
      "E=mc^2",
      "$$",
      "",
      "$$",
      "\\begin{align}",
      "F &= ma \\\\",
      "p &= mv",
      "\\end{align}",
      "$$",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
      "",
      "end",
    ].join("\n"),
  );
  await start(page);
  await openDocument(page, path);
  const content = editor(page);
  await expect(content.getByTestId("code-lang-badge")).toHaveAttribute(
    "data-lang",
    "js",
  );
  await expect(content.locator(".k-tok-keyword")).toHaveText(["const", "let"]);
  await expect(content.locator(".k-tok-comment")).toHaveText("// note");
  const numbered = content.locator(".k-codeblock-line-numbered");
  await expect(numbered).toHaveCount(0);
  const blocks = content.getByTestId("math-block");
  await expect(blocks).toHaveCount(3);
  for (const block of await blocks.all()) {
    await expect(block.locator("svg").first()).toBeVisible();
  }
  const numbers = content.getByTestId("math-eq-number");
  await expect(numbers).toHaveCount(0);

  const panel = await preferences(page);
  await panel.getByLabel("程式碼行號").check();
  await panel.getByLabel("公式自動編號").check();
  await applyPreferences(page);
  await expect(numbered).toHaveCount(2);
  expect(
    await numbered.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el, "::before").content),
    ),
  ).toEqual(['"1"', '"2"']);
  await expect(numbers).toHaveText(["(1)", "(2) (3)", "(4)"]);

  await blocks.first().click();
  await expect(line(page, "E=mc^2")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type("+1");
  const preview = content.getByTestId("math-block-preview");
  const editedTex = /^\s*E=mc\^2\+1\s*$/;
  await expect(preview).toHaveAttribute("data-tex", editedTex);
  await expect(preview.locator("svg").first()).toBeVisible();
  await content.press("ControlOrMeta+End");
  await expect(blocks.first()).toHaveAttribute("data-tex", editedTex);
  await expect(numbers).toHaveText(["(1)", "(2) (3)", "(4)"]);
  await expect(content.getByTestId("math-error")).toHaveCount(0);

  await preferences(page);
  await panel.getByLabel("程式碼行號").uncheck();
  await panel.getByLabel("公式自動編號").uncheck();
  await applyPreferences(page);
  await expect(numbered).toHaveCount(0);
  await expect(numbers).toHaveCount(0);
  const saving = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await documentFrom(await saving);
  expect((await databaseDocument(request, doc.id)).content).toContain(
    "$$\nE=mc^2+1\n$$",
  );
  expect(external).toEqual([]);
});

test("WEB-05: visible controls apply real focus dimming, typewriter centering and persistent custom CSS", async ({
  page,
  browser,
  request,
  name,
}) => {
  const path = `${name}.md`;
  await seedDocument(
    request,
    path,
    [
      "第一段 current",
      "",
      "第二段 other",
      "",
      ...Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`),
    ].join("\n"),
  );
  await start(page);
  await openDocument(page, path);
  const panel = await preferences(page);
  await panel.getByLabel("Ataraxia 專注模式").check();
  await panel.getByLabel("Stichos 打字機模式").check();
  await panel.getByRole("combobox", { name: /主題/ }).selectOption("melan");
  await panel.getByLabel("字體大小").fill("21");
  await panel.getByLabel("內容寬度").fill("760");
  await panel.getByLabel("自訂主題 CSS").setInputFiles({
    name: "parity.css",
    mimeType: "text/css",
    buffer: Buffer.from(".cm-content .cm-line { letter-spacing: 2px; }"),
  });
  await applyPreferences(page);
  const first = line(page, "第一段 current");
  const second = line(page, "第二段 other");
  await expect(first).toHaveCSS("letter-spacing", "2px");
  const opacity = (target: typeof first) =>
    target.evaluate((el) => Number(getComputedStyle(el).opacity));
  await editor(page).press("ControlOrMeta+Home");
  await expect.poll(() => opacity(second)).toBeLessThan(0.6);
  await expect(first).toHaveCSS("opacity", "1");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(second).toHaveCSS("opacity", "1");
  await expect.poll(() => opacity(first)).toBeLessThan(0.6);

  const centerOffset = () =>
    editor(page).evaluate((content) => {
      const scroller = content.closest(".cm-scroller")?.getBoundingClientRect();
      const active = window
        .getSelection()
        ?.anchorNode?.parentElement?.closest(".cm-line")
        ?.getBoundingClientRect();
      if (!scroller || !active) return 1;
      return (
        Math.abs(
          active.top + active.height / 2 - (scroller.top + scroller.height / 2),
        ) / scroller.height
      );
    });
  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => caretLine(page)).toBe("Line 200");
  await expect.poll(centerOffset).toBeLessThan(0.15);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await expect.poll(() => caretLine(page)).toBe("Line 199 typed");
  await expect.poll(centerOffset).toBeLessThan(0.15);
  await page.keyboard.press("ControlOrMeta+Home");
  await expect.poll(() => caretLine(page)).toBe("第一段 current");
  await expect.poll(centerOffset).toBeLessThan(0.15);

  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await start(reopened);
    await openDocument(reopened, path);
    await expect(reopened.locator("html")).toHaveAttribute(
      "data-theme",
      "melan",
    );
    await expect(editor(reopened)).toHaveCSS("font-size", "21px");
    await expect(editor(reopened)).toHaveCSS("max-width", "760px");
    await expect(line(reopened, "第一段 current")).toHaveCSS(
      "letter-spacing",
      "2px",
    );
    const restored = await preferences(reopened);
    await expect(restored.getByLabel("Ataraxia 專注模式")).toBeChecked();
    await expect(restored.getByLabel("Stichos 打字機模式")).toBeChecked();
    await restored
      .getByRole("button", { name: "移除自訂主題", exact: true })
      .click();
    await applyPreferences(reopened);
    await expect(line(reopened, "第一段 current")).not.toHaveCSS(
      "letter-spacing",
      "2px",
    );
    const saved = await request.get("/api/settings");
    await expect(saved).toBeOK();
    expect(await saved.json()).toMatchObject({
      customCss: "",
      focus: true,
      typewriter: true,
    });
  } finally {
    await fresh.close();
  }
});
