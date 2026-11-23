import type { Page } from "@playwright/test";
import type { SearchResults } from "../shared/search";
import {
  editor,
  expect,
  seedDocument,
  start,
  test,
  waitForApi,
} from "./fixtures";

const search = (page: Page) =>
  page.getByRole("searchbox", { name: "搜尋文件內容" });
const summary = (page: Page) =>
  page.locator(".workspace-content-search-status");
const groups = (page: Page) => page.locator(".workspace-content-search-group");
const hits = (page: Page) => page.locator(".workspace-content-search-hit");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function showSearch(page: Page) {
  await page.locator('#workspace-view [data-view="search"]').click();
  await expect(search(page)).toBeFocused();
}

test("workspace content search groups snippets and jumps to a UTF-16 line and column", async ({
  name,
  page,
  request,
}) => {
  await seedDocument(
    request,
    `${name}/alpha.md`,
    `${name}\r\n🙂 ${name} <safe>\r\n`,
  );
  await seedDocument(
    request,
    `${name}/notes/beta.md`,
    `# Beta\n\n| column |\n| --- |\n| ${name} |\n`,
  );
  await seedDocument(request, `${name}/filename-only.md`, "No content match.");
  const trashed = await seedDocument(request, `${name}/trash.md`, name);
  await expect(
    await request.patch(`/api/documents/${trashed.id}`, {
      data: { revision: trashed.revision, deleted: true },
    }),
  ).toBeOK();

  await start(page);
  await page.locator("#toggle-sidebar").click();
  await expect(page.locator("#workspace-sidebar")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(search(page)).toBeFocused();
  await search(page).fill(name);
  await search(page).press("Enter");
  await expect(summary(page)).toHaveText("3 筆結果，2 個檔案");
  await expect(groups(page)).toHaveCount(2);
  const [alpha, beta] = [groups(page).nth(0), groups(page).nth(1)];
  await expect(alpha.locator("summary")).toContainText("alpha.md");
  await expect(beta.locator("summary")).toContainText(`${name}/notes`);
  const hit = alpha.locator("button").nth(1);
  await expect(hit.locator("mark")).toHaveText(name);
  await expect(hit).toContainText("<safe>");
  await expect(hit).toHaveAttribute("data-line", "2");
  await expect(hit).toHaveAttribute("data-column", "4");
  await alpha.locator("summary").press("Enter");
  await expect(hit).toBeHidden();
  await alpha.locator("summary").press("Space");
  await hit.press("Enter");
  await expect(editor(page)).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(name);
  await beta.locator("button").click();
  await expect(page.locator(".k-table-cell-content:focus")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(name);

  // Leaving content search restores the existing literal filter, including trash.
  await page.locator('#workspace-view [data-view="list"]').click();
  const filter = page.getByRole("searchbox", { name: "搜尋工作區" });
  await filter.fill(name);
  const documents = page.locator("#workspace-documents");
  await expect(
    documents.getByRole("button", { name: `${name}/filename-only.md` }),
  ).toBeVisible();
  await page.locator('#workspace-view [data-view="trash"]').click();
  await expect(
    documents.getByRole("button", { name: `還原 ${name}/trash.md` }),
  ).toBeVisible();
  await expect(search(page)).toBeHidden();
});

test("search options are independent and invalid regex can be corrected", async ({
  name,
  page,
  request,
}) => {
  const term = `Cat${name.slice(-12)}`;
  await seedDocument(
    request,
    `${name}.md`,
    `${term} ${term.toLowerCase()} prefix${term.toLowerCase()} ${term.toLowerCase()}_suffix ${term}-12`,
  );
  await start(page);
  await showSearch(page);
  const input = search(page);
  await input.fill(term.toLowerCase());
  await expect(summary(page)).toHaveText("5 筆結果，1 個檔案");
  const toggle = (label: string) =>
    page.getByRole("button", { name: label, exact: true });
  await toggle("區分大小寫").click();
  await expect(summary(page)).toHaveText("3 筆結果，1 個檔案");
  await toggle("全字比對").click();
  await expect(summary(page)).toHaveText("1 筆結果，1 個檔案");
  await expect(hits(page).locator("mark")).toHaveText(term.toLowerCase());
  await input.fill(`${term}-(\\d+)`);
  await expect(summary(page)).toHaveText("無結果");
  await toggle("正規表示式").click();
  await expect(hits(page).locator("mark")).toHaveText(`${term}-12`);
  await input.fill(`${term}-(\\d+`);
  await expect(summary(page)).toHaveText("正規表示式無效");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(hits(page)).toHaveCount(0);
  await input.fill(`${term}-(\\d+)`);
  await expect(summary(page)).toHaveText("1 筆結果，1 個檔案");
  await expect(input).not.toHaveAttribute("aria-invalid");
  await input.press("Escape");
  await expect(input).toBeEmpty();
  await expect(summary(page)).toBeEmpty();
});

test("search caps the response and distinguishes an exact cap from truncation", async ({
  name,
  request,
  page,
}) => {
  const term = name.slice(-12);
  const doc = await seedDocument(
    request,
    `${name}.md`,
    `${term}\n`.repeat(1000),
  );
  const exact = await request.get("/api/search", { params: { q: term } });
  await expect(exact).toBeOK();
  const exactBody: SearchResults = await exact.json();
  expect(exactBody.hits).toHaveLength(1000);
  expect(exactBody.truncated).toBe(false);
  await expect(
    await request.patch(`/api/documents/${doc.id}`, {
      data: { revision: doc.revision, content: `${term} `.repeat(1001) },
    }),
  ).toBeOK();
  await start(page);
  await showSearch(page);
  await search(page).fill(term);
  await expect(summary(page)).toContainText("1000+ 筆結果，1 個檔案（已截斷");
  await expect(hits(page)).toHaveCount(1000);
  await expect(hits(page).last()).toHaveAttribute(
    "data-column",
    String(1 + 999 * (term.length + 1)),
  );
});

test("content search preserves offsets for control characters and literal punctuation", async ({
  name,
  request,
}) => {
  const term = `${name.slice(-12)}.*`;
  await seedDocument(request, `${name}.md`, `\u0001\u0002${term} bar ${term}`);
  const literal = await request.get("/api/search", { params: { q: term } });
  await expect(literal).toBeOK();
  const data: SearchResults = await literal.json();
  expect(data.hits.map(({ column, match }) => [column, match])).toEqual([
    [3, term],
    [3 + term.length + 5, term],
  ]);
  const empty = await request.get("/api/search", {
    params: { q: "^", regex: "1" },
  });
  await expect(empty).toBeOK();
  expect(await empty.json()).toEqual({ hits: [], truncated: false });
  const oversized = await request.get("/api/search", {
    params: { q: "🙂".repeat(257) },
  });
  expect(oversized.status()).toBe(400);
});

test("a canceled search does not replace the latest matches", async ({
  name,
  page,
  request,
}) => {
  const old = `${name}-old`;
  const latest = `${name}-latest`;
  await seedDocument(request, `${name}.md`, `${old}\n${latest}`);
  await start(page);
  await showSearch(page);
  const delayed = deferred();
  const release = deferred();
  const finished = deferred();
  await page.route("**/api/search?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== old) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    delayed.resolve();
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
    finished.resolve();
  });
  await search(page).fill(old);
  await delayed.promise;
  try {
    await search(page).fill(latest);
    await expect(hits(page).locator("mark")).toHaveText(latest);
  } finally {
    release.resolve();
  }
  await finished.promise;
  await expect(hits(page).locator("mark")).toHaveText(latest);
});

test("content search waits for IME composition to finish", async ({
  name,
  page,
  request,
}) => {
  const term = `搜尋${name.slice(-12)}`;
  await seedDocument(request, `${name}.md`, term);
  await start(page);
  await showSearch(page);
  const input = search(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.pathname === "/api/search")
      requests.push(target.searchParams.get("q") ?? "");
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "搜",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page.waitForTimeout(350);
  expect(requests).toEqual([]);
  await expect(summary(page)).toBeEmpty();
  const response = waitForApi(page, "GET", "search");
  await cdp.send("Input.insertText", { text: term });
  await response;
  await expect(input).toHaveValue(term);
  await expect(summary(page)).toHaveText("1 筆結果，1 個檔案");
  expect(requests).toEqual([term]);
});
