import {
  databaseDocument,
  editor,
  expect,
  openDocument,
  seedDocument,
  start,
  test,
} from "./fixtures";

const markdown = [
  "# 文件寫作流程",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Collect research notes] --> B[Outline the key sections]",
  "  B --> C[Write the first draft]",
  "  C --> D[Review with the team]",
  "  D --> E[Publish final version]",
  "```",
].join("\n");

test("clicking the Mermaid diagram opens a larger image; clicking the image closes it", async ({
  page,
  request,
  name,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const path = `${name}.md`;
  const doc = await seedDocument(request, path, markdown);
  await start(page);
  await openDocument(page, path);
  const preview = page.getByTestId("diagram").getByRole("button", {
    name: "放大圖表",
  });
  await expect(preview).toBeVisible();
  const inline = page.getByTestId("diagram").locator(".k-diagram-svg");
  await expect(inline).toHaveCSS("scrollbar-width", "none");
  await inline.hover();
  await page.mouse.wheel(160, 0);
  await expect
    .poll(() => inline.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  const visiblePreviewWidth = await preview.locator("svg").evaluate((svg) => {
    const clip = svg.closest(".k-diagram-svg");
    return Math.min(svg.getBoundingClientRect().width, clip?.clientWidth ?? 0);
  });
  const scroller = page.locator("#editor-container .cm-scroller");
  const scrollTop = await scroller.evaluate((node) => node.scrollTop);

  await preview.click();
  const reader = page.getByRole("dialog", { name: "放大圖表" });
  await expect(reader).toBeVisible();
  const enlarged = reader.getByRole("button", { name: "關閉放大圖表" });
  const image = enlarged.locator("img");
  const renderedPixels = await image.evaluate(async (img) => {
    if (!(img instanceof HTMLImageElement))
      throw new Error("Expected an image");
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.filter((channel, index) => index % 4 === 3 && channel > 0)
      .length;
  });
  expect(renderedPixels).toBeGreaterThan(50);
  expect(await image.evaluate((img) => img.clientWidth)).toBeGreaterThan(
    visiblePreviewWidth,
  );
  const frame = await reader.boundingBox();
  const graphic = await image.boundingBox();
  if (!frame || !graphic) throw new Error("Missing diagram or frame");
  expect(frame.width).toBeCloseTo(graphic.width, 0);
  expect(frame.height).toBeCloseTo(graphic.height, 0);
  expect(frame.height).toBeLessThan(300);
  await page.screenshot({ path: testInfo.outputPath("mermaid-reader.png") });

  await enlarged.click();
  await expect(reader).not.toBeVisible();
  await expect(preview).toBeFocused();
  await preview.click();
  await expect(reader).toBeVisible();
  await page.mouse.click(frame.x + frame.width / 2, frame.y / 2);
  await expect(reader).not.toBeVisible();
  await expect(preview).toBeFocused();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  expect(await databaseDocument(request, doc.id)).toMatchObject({
    content: markdown,
    revision: doc.revision,
  });
});

test("Mermaid reader fits on a narrow screen and supports zoom, scroll, and keyboard dismissal", async ({
  page,
  request,
  name,
}) => {
  const path = `${name}.md`;
  await seedDocument(request, path, markdown);
  await start(page);
  await openDocument(page, path);
  const preview = page.getByTestId("diagram").getByRole("button", {
    name: "放大圖表",
  });
  await preview.press("Enter");
  const reader = page.getByRole("dialog", { name: "放大圖表" });
  const enlarged = reader.getByRole("button", { name: "關閉放大圖表" });
  await expect(enlarged).toBeFocused();
  await expect(reader.getByRole("button")).toHaveCount(1);
  await expect(reader).toHaveText("");
  await page.setViewportSize({ width: 390, height: 680 });
  const stage = reader.locator("#diagram-reader-stage");
  const image = enlarged.locator("img");
  await expect
    .poll(() => image.evaluate((node) => node.clientWidth))
    .toBeLessThan(390);
  const width = await stage.evaluate((node) => node.clientWidth);
  await expect
    .poll(() => stage.evaluate((node) => node.scrollWidth))
    .toBeLessThanOrEqual(width + 1);

  await page.keyboard.press("Shift+Equal");
  await expect
    .poll(() => image.evaluate((node) => node.clientWidth))
    .toBeGreaterThan(width);
  await expect(stage).toHaveCSS("scrollbar-width", "none");
  const left = await stage.evaluate((node) => node.scrollLeft);
  await stage.press("ArrowRight");
  await expect
    .poll(() => stage.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(left);
  await page.keyboard.press("Minus");
  await expect
    .poll(() => stage.evaluate((node) => node.scrollWidth))
    .toBeLessThanOrEqual(width + 1);

  await stage.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -360);
  await page.keyboard.up("Control");
  await expect
    .poll(() => image.evaluate((node) => node.clientWidth))
    .toBeGreaterThan(width);

  await page.keyboard.press("Escape");
  await expect(reader).not.toBeVisible();
  await expect(preview).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator("#source-mode").click();
  await expect(editor(page)).toContainText("flowchart LR");
  await expect(preview).toHaveCount(0);
});
