import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  appendText,
  databaseDocument,
  documentFrom,
  downloadMarkdown,
  editor,
  expect,
  openDocument,
  seedDocument,
  start,
  status,
  test,
  waitForApi,
} from "./fixtures";

const exec = promisify(execFile);
const composeFile = fileURLToPath(new URL("../compose.yaml", import.meta.url));
const project = process.env.TEST_WEB_COMPOSE_PROJECT;

async function compose(...args: string[]) {
  if (!project || !/^kalamos-web-test-[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new Error(
      "TEST_WEB_COMPOSE_PROJECT must name a dedicated kalamos-web-test-* project.",
    );
  }
  const { stdout } = await exec(
    "docker",
    ["compose", "-f", composeFile, "-p", project, ...args],
    { timeout: 30_000 },
  );
  return stdout.trim();
}

test("WEB-04: PostgreSQL outage keeps edits downloadable, recoverable, and retryable", async ({
  page,
  request,
  name,
  baseURL,
}) => {
  test.skip(
    !project,
    "Set TEST_WEB_COMPOSE_PROJECT for the isolated PostgreSQL outage test.",
  );
  expect(`http://${await compose("port", "app", "4173")}`).toBe(baseURL);
  const path = `${name}.md`;
  const original = "Database original";
  const edited = `${original} — unsaved 中文`;
  const doc = await seedDocument(request, path, original);
  await start(page);
  await openDocument(page, path);
  await appendText(page, " — unsaved 中文");

  try {
    // Match the target app to the explicit test project before stopping its DB.
    await compose("stop", "db");
    const rejected = waitForApi(page, "PATCH", `documents/${doc.id}`);
    await page.locator("#save-document").click();
    expect((await rejected).status()).toBe(503);
    await expect(status(page)).toContainText("尚未儲存");
    await expect(editor(page)).toContainText(edited);
    expect((await downloadMarkdown(page)).bytes).toEqual(Buffer.from(edited));
  } finally {
    await compose("start", "--wait", "--wait-timeout", "20", "db");
  }

  expect((await databaseDocument(request, doc.id)).content).toBe(original);
  await start(page);
  await openDocument(page, path);
  await page
    .locator("#decision-dialog")
    .getByRole("button", { name: "救回草稿", exact: true })
    .click();
  await expect(editor(page)).toContainText(edited);
  await expect(status(page)).toContainText("尚未儲存");
  const retry = waitForApi(page, "PATCH", `documents/${doc.id}`);
  await page.locator("#save-document").click();
  expect((await documentFrom(await retry)).content).toBe(edited);
  await expect(status(page)).toHaveText("已儲存");
  expect((await databaseDocument(request, doc.id)).content).toBe(edited);
});
