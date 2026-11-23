import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type APIRequestContext,
  test as base,
  expect,
  type Page,
  type Response,
} from "@playwright/test";
import type { WorkspaceDocument } from "../shared/api";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6rgLAAJXAYihuo7TAAAAAElFTkSuQmCC",
  "base64",
);

export const test = base.extend<{ name: string }>({
  name: async ({ request }, use) => {
    const previous = await request.get("/api/settings");
    await expect(previous).toBeOK();
    await expect(
      await request.post("/api/settings", { data: { autosave: false } }),
    ).toBeOK();
    try {
      await use(`acceptance-${randomUUID()}`);
    } finally {
      await expect(
        await request.post("/api/settings", { data: await previous.json() }),
      ).toBeOK();
    }
  },
});
export { expect };

test.beforeAll(async ({ request }) => {
  if (process.env.TEST_WEB_ALLOW_WRITES !== "1") {
    throw new Error(
      "Start a dedicated test Web/API and PostgreSQL, then set TEST_WEB_ALLOW_WRITES=1. Do not use your development database.",
    );
  }
  await expect(await request.get("/api/health")).toBeOK();
});

export function editor(page: Page) {
  return page.locator("#editor-container .cm-content");
}

export function status(page: Page) {
  return page.locator("#workspace-status");
}

export async function start(page: Page) {
  await page.goto("/");
  await expect(status(page)).toHaveText("工作區已連線");
}

export async function fileOperation(page: Page, id: string) {
  const menu = page.locator("#file-actions");
  if (!(await menu.isVisible())) {
    await page.locator("#file-actions-trigger").click();
  }
  await menu.locator(`#${id}`).click();
}

export function waitForApi(page: Page, method: string, pathname: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === `/api/${pathname}`,
  );
}

export async function documentFrom(response: Response) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as WorkspaceDocument;
}

export async function databaseDocument(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/documents/${id}`);
  await expect(response).toBeOK();
  return (await response.json()) as WorkspaceDocument;
}

export async function pickMarkdown(
  page: Page,
  source: string | { name: string; mimeType: string; buffer: Buffer },
) {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#import-markdown").click();
  await (await chooser).setFiles(source);
}

export async function setPath(page: Page, path: string) {
  const dialog = page.locator("#path-dialog");
  await dialog.locator("#document-path").fill(path);
  await dialog.getByRole("button", { name: "確認", exact: true }).click();
}

export async function openDocument(page: Page, path: string) {
  await page.locator('#workspace-view [data-view="list"]').click();
  await page.locator("#workspace-search").fill(path);
  await page
    .locator("#workspace-documents")
    .getByRole("button", { name: path, exact: true })
    .click();
  await expect(editor(page)).toBeVisible();
}

export async function appendText(page: Page, text: string) {
  await editor(page).press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
}

export async function downloadMarkdown(page: Page) {
  const downloaded = page.waitForEvent("download");
  await fileOperation(page, "download-document");
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  return {
    name: download.suggestedFilename(),
    bytes: await readFile(await download.path()),
  };
}

export async function seedDocument(
  request: APIRequestContext,
  path: string,
  content: string,
  attachments?: { path: string; mime: string; data: string }[],
) {
  const response = await request.post("/api/documents", {
    data: { path, content, attachments },
  });
  await expect(response).toBeOK();
  return (await response.json()) as WorkspaceDocument;
}
