import { readFile } from "node:fs/promises";
import type { APIRequestContext, JSHandle, Page } from "@playwright/test";
import {
  appendText,
  databaseDocument,
  documentFrom,
  downloadMarkdown,
  editor,
  expect,
  fileOperation,
  openDocument,
  png,
  seedDocument,
  setPath,
  start,
  status,
  test,
  waitForApi,
} from "./fixtures";
import {
  fixtureImageUrl,
  refusedPng,
  widePng,
} from "./fixtures-image-uploader";

const uploadLog = process.env.TEST_WEB_IMAGE_UPLOAD_LOG;
const uploadEndpoint = "/api/convert/upload";

function pngFile(name: string, bytes: Buffer = png) {
  return { name, mimeType: "image/png", buffer: bytes };
}

function attachment(path: string, bytes: Buffer = png) {
  return { path, mime: "image/png", data: bytes.toString("base64") };
}

async function storedImage(
  request: APIRequestContext,
  path: string,
  bytes: Buffer,
) {
  const response = await request.get("/api/assets", { params: { path } });
  await expect(response).toBeOK();
  expect(response.headers()["content-type"]).toContain("image/png");
  expect(await response.body()).toEqual(bytes);
}

async function chooseImage(
  page: Page,
  action: string,
  file: ReturnType<typeof pngFile>,
) {
  const chooser = page.waitForEvent("filechooser");
  await fileOperation(page, action);
  await (await chooser).setFiles(file);
}

async function fileTransfer(
  page: Page,
  ...files: ReturnType<typeof pngFile>[]
) {
  return page.evaluateHandle(
    (files) => {
      const transfer = new DataTransfer();
      for (const { name, mimeType, bytes } of files)
        transfer.items.add(
          new File([new Uint8Array(bytes)], name, { type: mimeType }),
        );
      return transfer;
    },
    files.map(({ name, mimeType, buffer }) => ({
      name,
      mimeType,
      bytes: Array.from(buffer),
    })),
  );
}

async function dropAtLineEnd(
  page: Page,
  line: string,
  dataTransfer: JSHandle<DataTransfer>,
) {
  const target = editor(page).locator(".cm-line").filter({ hasText: line });
  const box = await target.boundingBox();
  if (!box) throw new Error("The editor's drop target is not visible.");
  const position = {
    dataTransfer,
    clientX: box.x + box.width - 2,
    clientY: box.y + box.height / 2,
  };
  await target.dispatchEvent("dragover", position);
  await target.dispatchEvent("drop", position);
}

async function pasteFile(page: Page, file: ReturnType<typeof pngFile>) {
  const clipboard = await fileTransfer(page, file);
  await editor(page).evaluate(
    (target, clipboardData) =>
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      ),
    clipboard,
  );
}

async function saveDocument(page: Page, id: string) {
  const saving = waitForApi(page, "PATCH", `documents/${id}`);
  await page.locator("#save-document").click();
  return documentFrom(await saving);
}

function uploadRequests(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === uploadEndpoint
    )
      paths.push(request.postDataJSON().path);
  });
  return paths;
}

async function promptUpload(page: Page) {
  await fileOperation(page, "upload-image");
  const dialog = page.locator("#decision-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("圖床");
  return dialog;
}

test("WEB-03: drop, paste, and place same-name PNGs at the intended positions", async ({
  page,
  browser,
  request,
  name,
}) => {
  const directory = `${name}/notes`;
  const path = `${directory}/post.md`;
  const content = "# Images\n\nDrop here\n\nPaste here\n\nPlace here\n\nEnd\n";
  const doc = await seedDocument(request, path, content);
  const filename = "same name (1)%20.png";
  await start(page);
  await openDocument(page, path);
  const drag = await fileTransfer(page, pngFile(filename));

  // Put the cursor elsewhere first; the drop should use the mouse coordinates.
  await editor(page).getByText("Place here", { exact: true }).click();
  const dropping = waitForApi(page, "POST", "assets");
  await dropAtLineEnd(page, "Drop here", drag);
  expect((await dropping).status()).toBe(201);
  await expect(page.getByTestId("image-widget").locator("img")).toHaveCount(1);

  await editor(page).getByText("Paste here", { exact: true }).click();
  await page.keyboard.press("End");
  const pasting = waitForApi(page, "POST", "assets");
  await pasteFile(page, pngFile(filename, widePng));
  expect((await pasting).status()).toBe(201);
  await expect(page.getByTestId("image-widget").locator("img")).toHaveCount(2);

  await editor(page).getByText("Place here", { exact: true }).click();
  await page.keyboard.press("End");
  const placing = waitForApi(page, "POST", "assets");
  await chooseImage(page, "insert-image", pngFile(filename, refusedPng));
  expect((await placing).status()).toBe(201);
  await expect(page.getByTestId("image-widget").locator("img")).toHaveCount(3);

  await saveDocument(page, doc.id);
  const saved = (await databaseDocument(request, doc.id)).content;
  const references = [
    ...saved.matchAll(
      /!\[\]\((assets\/[^)\n]*same%20name%20%281%29%2520\.png)\)/g,
    ),
  ].map((match) => match[1]);
  expect(references).toHaveLength(3);
  expect(new Set(references).size).toBe(3);
  const [dropped, pasted, placed] = references;
  expect(saved).toBe(
    `# Images\n\nDrop here\n![](${dropped})\n\nPaste here\n![](${pasted})\n\nPlace here\n![](${placed})\n\nEnd\n`,
  );
  await storedImage(
    request,
    `${directory}/${decodeURIComponent(dropped)}`,
    png,
  );
  await storedImage(
    request,
    `${directory}/${decodeURIComponent(pasted)}`,
    widePng,
  );
  await storedImage(
    request,
    `${directory}/${decodeURIComponent(placed)}`,
    refusedPng,
  );

  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await start(reopened);
    await openDocument(reopened, path);
    const images = reopened.getByTestId("image-widget").locator("img");
    await expect(images).toHaveCount(3);
    for (const [index, width] of [1, 40, 60].entries())
      await expect(images.nth(index)).toHaveJSProperty("naturalWidth", width);
  } finally {
    await fresh.close();
  }
});

test("WEB-03: drop Markdown with an image onto an empty editor, then paste a BMP", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  const content = "# Dropped article\n\nBody\n";
  await start(page);
  const empty = page.locator("#empty-workspace");
  await expect(empty).toBeVisible();
  const dataTransfer = await fileTransfer(
    page,
    { name: path, mimeType: "text/markdown", buffer: Buffer.from(content) },
    pngFile("dropped.png"),
  );
  const creating = waitForApi(page, "POST", "documents");
  await empty.dispatchEvent("drop", { dataTransfer });
  const doc = await documentFrom(await creating);
  expect(doc).toMatchObject({ path, content });
  const images = page.getByTestId("image-widget").locator("img");
  await expect(images).toHaveJSProperty("naturalWidth", 1);

  const bmp = Buffer.from(
    "Qk0+AAAAAAAAADYAAAAoAAAAAgAAAAEAAAABABgAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAf39/f39/AAA=",
    "base64",
  );
  await editor(page).press("ControlOrMeta+End");
  const pasting = waitForApi(page, "POST", "assets");
  await pasteFile(page, {
    name: "pasted.bmp",
    mimeType: "image/bmp",
    buffer: bmp,
  });
  expect((await pasting).status()).toBe(201);
  await expect(images.nth(1)).toHaveJSProperty("naturalWidth", 2);
  await saveDocument(page, doc.id);
  const saved = (await databaseDocument(request, doc.id)).content;
  expect(saved).toMatch(/!\[\]\(assets\/[^)]+-dropped\.png\)/);
  const bmpPath = /!\[\]\((assets\/[^)]+-pasted\.bmp)\)/.exec(saved)?.[1];
  expect(bmpPath).toBeDefined();
  const image = await request.get("/api/assets", {
    params: { path: bmpPath ?? "" },
  });
  await expect(image).toBeOK();
  expect(image.headers()["content-type"]).toContain("image/bmp");
  expect(await image.body()).toEqual(bmp);
});

test("WEB-03: mixed drop inserts into the active document before opening the dropped Markdown", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}/existing.md`;
  const existing = await seedDocument(
    request,
    path,
    "# Existing article\n\nBody\n",
  );
  const droppedPath = `${name}-dropped.md`;
  const droppedContent = "# Another article\n\nLocal file\n";
  await start(page);
  await openDocument(page, path);
  const dataTransfer = await fileTransfer(page, pngFile("mixed.png"), {
    name: droppedPath,
    mimeType: "text/markdown",
    buffer: Buffer.from(droppedContent),
  });
  const creating = waitForApi(page, "POST", "documents");
  await dropAtLineEnd(page, "Body", dataTransfer);
  const dropped = await documentFrom(await creating);
  await expect(editor(page)).toContainText("Another article");
  await expect(page.getByTestId("image-widget")).toHaveCount(0);
  expect(dropped).toMatchObject({ path: droppedPath, content: droppedContent });

  await openDocument(page, path);
  await expect(
    page.getByTestId("image-widget").locator("img"),
  ).toHaveJSProperty("naturalWidth", 1);
  const saved = await saveDocument(page, existing.id);
  const reference = /!\[\]\((assets\/[^)]+-mixed\.png)\)/.exec(
    saved.content,
  )?.[1];
  expect(reference).toBeDefined();
  expect(saved.content).toBe(`# Existing article\n\nBody\n![](${reference})\n`);
  await storedImage(request, `${name}/${reference}`, png);
  expect((await databaseDocument(request, dropped.id)).content).toBe(
    droppedContent,
  );
});

test("WEB-03: preferences root persists, Typora root overrides it, and preview applies image size", async ({
  page,
  request,
  name,
}) => {
  const preferencesDoc = `${name}/notes/preferences.md`;
  const typoraDoc = `${name}/notes/front-matter.md`;
  const source =
    '<img alt="Zoomed" src="/images/hero.png" style="zoom:50%">\n\n<img alt="Sized" src="/images/hero.png" width="80">\n\n![Not attached](/images/missing.png)\n\nEnd\n';
  await seedDocument(request, preferencesDoc, source, [
    attachment(`${name}/preferences/images/hero.png`, widePng),
  ]);
  const typoraSource = `---\ntypora-root-url: ../typora\n---\n\n${source}`;
  const typora = await seedDocument(request, typoraDoc, typoraSource, [
    attachment(`${name}/typora/images/hero.png`, refusedPng),
  ]);
  await start(page);
  await openDocument(page, preferencesDoc);
  const fallback = page.getByTestId("image-fallback");
  await expect(fallback.filter({ hasText: "Zoomed" })).toBeVisible();
  const preferences = page.locator("#preferences-dialog");
  await page.locator("#open-preferences").click();
  await preferences
    .getByRole("textbox", { name: "圖片根路徑" })
    .fill(`/${name}/preferences`);
  const setting = waitForApi(page, "POST", "settings");
  await preferences.getByRole("button", { name: "套用" }).click();
  expect((await setting).ok()).toBe(true);

  const zoomed = page.getByRole("img", { name: "Zoomed" });
  const sized = page.getByRole("img", { name: "Sized" });
  await expect(zoomed).toHaveJSProperty("naturalWidth", 40);
  await expect(zoomed).toHaveCSS("width", "20px");
  await expect(sized).toHaveCSS("width", "80px");
  await expect(fallback.filter({ hasText: "Not attached" })).toContainText(
    "/images/missing.png",
  );

  await start(page);
  await openDocument(page, preferencesDoc);
  await expect(zoomed).toHaveJSProperty("naturalWidth", 40);
  await openDocument(page, typoraDoc);
  await expect(zoomed).toHaveJSProperty("naturalWidth", 60);
  await expect(zoomed).toHaveCSS("width", "30px");
  await expect(fallback.filter({ hasText: "Not attached" })).toContainText(
    "/images/missing.png",
  );
  expect((await databaseDocument(request, typora.id)).content).toBe(
    typoraSource,
  );
});

test("WEB-03: reject spoofed MIME, over-limit images, and an occupied attachment path", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}/post.md`;
  const assetPath = `${name}/assets/example.png`;
  const content = "# Keep image\n\n![Kept](assets/example.png)\n";
  const doc = await seedDocument(request, path, content, [
    attachment(assetPath),
  ]);
  await start(page);
  await openDocument(page, path);
  const image = page.getByRole("img", { name: "Kept" });
  await expect(image).toHaveJSProperty("naturalWidth", 1);

  const rejectingMime = waitForApi(page, "POST", "assets");
  await chooseImage(
    page,
    "insert-image",
    pngFile("spoof.png", Buffer.from("not a PNG")),
  );
  expect((await rejectingMime).status()).toBe(415);
  await expect(status(page)).toContainText("Only matching PNG");
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(content);

  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/assets"
    )
      requests.push(request.postDataJSON().path);
  });
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  png.copy(oversized);
  await chooseImage(page, "insert-image", pngFile("too-large.png", oversized));
  await expect(status(page)).toContainText("10 MiB");
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(content);
  expect(requests).toEqual([]);

  await chooseImage(page, "import-attachment", pngFile("example.png", widePng));
  await expect(page.locator("#document-path")).toHaveValue(assetPath);
  const collision = waitForApi(page, "POST", "assets");
  await setPath(page, assetPath);
  expect((await collision).status()).toBe(409);
  await expect(status(page)).toContainText(
    "A different attachment already uses this path",
  );
  await expect(image).toHaveJSProperty("naturalWidth", 1);
  await storedImage(request, assetPath, png);
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(content);
  expect((await databaseDocument(request, doc.id)).content).toBe(content);
});

test("WEB-03: unconfigured image upload tells the user an operator must enable it", async ({
  page,
  request,
  name,
}) => {
  test.skip(
    !!uploadLog,
    "Run against the isolated app without an uploader override.",
  );
  const path = `${name}/post.md`;
  const content = "# Image\n\n![Local](assets/hero.png)\n\nEnd\n";
  const doc = await seedDocument(request, path, content, [
    attachment(`${name}/assets/hero.png`),
  ]);
  await start(page);
  await openDocument(page, path);
  await expect(page.getByRole("img", { name: "Local" })).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  const dialog = await promptUpload(page);
  const rejecting = waitForApi(page, "POST", "convert/upload");
  await dialog.getByRole("button", { name: "上傳", exact: true }).click();
  expect((await rejecting).status()).toBe(503);
  await expect(status(page)).toContainText(/未設定|not configured/i);
  await expect(status(page)).toContainText(/管理者|管理員|操作者|operator/i);
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(content);
  expect((await databaseDocument(request, doc.id)).content).toBe(content);
});

test("WEB-03: configured image upload runs only on confirmation and replaces references only on success", async ({
  page,
  context,
  baseURL,
  request,
  name,
}) => {
  test.skip(
    !uploadLog,
    "Set TEST_WEB_IMAGE_UPLOAD_LOG when the local executable fixture is mounted.",
  );
  if (!uploadLog)
    throw new Error("The configured test requires the fixture log path.");
  const readCalls = () => readFile(uploadLog, "utf8");
  const previousCalls = await readCalls();
  const uploads = uploadRequests(page);
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === baseURL) return route.continue();
    if (url === fixtureImageUrl && route.request().method() === "GET")
      return route.fulfill({ contentType: "image/png", body: widePng });
    return route.abort();
  });

  const path = `${name}/post.md`;
  const success = `${name}/assets/success.png`;
  const failure = `${name}/assets/failure.png`;
  const local = '![Hero](assets/success.png "Title")';
  const original = `# Image upload\n\n${local}\n\n<img alt="Kept local" src="assets/failure.png" width="80">\n\nEnd`;
  const doc = await seedDocument(request, path, original, [
    attachment(success, widePng),
    attachment(failure, refusedPng),
  ]);
  await start(page);
  await openDocument(page, path);
  await expect(page.getByRole("img", { name: "Hero" })).toHaveJSProperty(
    "naturalWidth",
    40,
  );
  await expect(page.getByRole("img", { name: "Kept local" })).toHaveJSProperty(
    "naturalWidth",
    60,
  );
  await appendText(page, " of article");
  const savedLocal = `${original} of article`;
  expect((await saveDocument(page, doc.id)).content).toBe(savedLocal);
  const cancel = await promptUpload(page);
  await cancel.getByRole("button", { name: "取消" }).click();
  await expect(cancel).toBeHidden();
  await start(page);
  await openDocument(page, path);
  await expect(page.getByRole("img", { name: "Hero" })).toHaveJSProperty(
    "naturalWidth",
    40,
  );
  expect(uploads).toEqual([]);
  expect(await readCalls()).toBe(previousCalls);

  // Upload all references: the second executable call fails, so neither URL changes.
  const attempt = await promptUpload(page);
  expect(uploads).toEqual([]);
  expect(await readCalls()).toBe(previousCalls);
  await attempt.getByRole("button", { name: "上傳", exact: true }).click();
  await expect(status(page)).toContainText(/上傳失敗.*Image uploader failed/);
  expect(uploads).toEqual([success, failure]);
  expect(await readCalls()).toBe(`${previousCalls}success\nfailure\n`);
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(savedLocal);

  // Put the caret inside the Markdown image and confirm: only this image is sent.
  await page.locator("#source-mode").click();
  await editor(page).locator(".cm-line").filter({ hasText: "![Hero]" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  const selected = await promptUpload(page);
  await selected.getByRole("button", { name: "上傳", exact: true }).click();
  await expect(status(page)).toHaveText("已上傳 1 張圖片");
  expect(uploads).toEqual([success, failure, success]);
  const afterUpload = `${previousCalls}success\nfailure\nsuccess\n`;
  expect(await readCalls()).toBe(afterUpload);
  const savedRemote = savedLocal.replace("assets/success.png", fixtureImageUrl);
  expect((await downloadMarkdown(page)).bytes.toString()).toBe(savedRemote);
  expect((await databaseDocument(request, doc.id)).content).toBe(savedLocal);
  expect((await saveDocument(page, doc.id)).content).toBe(savedRemote);
  await page.locator("#source-mode").click();
  await editor(page).press("ControlOrMeta+End");
  await expect(page.getByRole("img", { name: "Hero" })).toHaveAttribute(
    "src",
    fixtureImageUrl,
  );
  await expect(page.getByRole("img", { name: "Kept local" })).toHaveJSProperty(
    "naturalWidth",
    60,
  );
  expect((await databaseDocument(request, doc.id)).content).toBe(savedRemote);
  expect(uploads).toEqual([success, failure, success]);
  expect(await readCalls()).toBe(afterUpload);
});
