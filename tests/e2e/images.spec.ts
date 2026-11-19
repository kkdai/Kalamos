import { expect, test } from "@playwright/test";
import { MOD, boot, getDoc, setCursor, setDoc, withIpc } from "./helpers";

/** Issue #13: IM-03 image size (`<img>` zoom / width) and IM-04 image root folder. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

// 200×100 SVG as a data URL (no network, no asset protocol needed).
const SVG_200 = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'><rect width='200' height='100' fill='teal'/></svg>",
)}`;

test("#13 IM-03 AC: <img style=\"zoom:50%\"> renders at half its natural width", async ({ page }) => {
  const src = `<img src="${SVG_200}" style="zoom:50%" onerror="window.__pwned=1">\n\n<img src="${SVG_200}" width="80">\n\nend`;
  await setDoc(page, src, src.length);
  const imgs = page.locator(".cm-content img.k-image-img");
  await expect(imgs).toHaveCount(2);
  await expect(page.getByTestId("image-widget").first()).toHaveAttribute("data-state", "loaded");
  const sizes = await imgs.evaluateAll((els) =>
    els.map((e) => {
      const img = e as HTMLImageElement;
      return { natural: img.naturalWidth, width: Math.round(img.getBoundingClientRect().width) };
    }),
  );
  expect(sizes[0].natural).toBe(200);
  expect(sizes[0].width).toBe(100);
  expect(sizes[1].width).toBe(80);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // Render only: the text is unchanged.
  expect(await getDoc(page)).toBe(src);

  // Cursor inside the tag shows the source.
  await setCursor(page, 3);
  await expect(imgs).toHaveCount(1);
  await expect(page.locator(".cm-line").first()).toContainText('style="zoom:50%"');
});

test("#13 IM-04 AC: after setting a root folder (Cmd+Opt+R), /img/a.png resolves under it", async ({ page }) => {
  const src = "![a](/img/a.png)\n\nend";
  await setDoc(page, src, src.length);
  // asset:// URLs do not load in a plain browser, so check the resolved path.
  const widget = page.getByTestId("image-widget");
  await expect(widget).toHaveCount(1);
  await expect(widget).toHaveAttribute("data-path", "/img/a.png");

  await withIpc(page, "ipc.setMockDialogHandlers({ openFolder: () => '/Users/me/blog' });");
  await page.keyboard.press(`${MOD}+Alt+KeyR`);
  await expect(page.getByTestId("status")).toHaveText("圖片根目錄：/Users/me/blog");
  await expect(widget).toHaveAttribute("data-path", "/Users/me/blog/img/a.png");
  expect(await withIpc<string[]>(page, "return ipc.getMockAllowedAssetDirs();")).toContain(
    "/Users/me/blog",
  );
  expect(await withIpc<string | null>(page, "return (await ipc.getSettings()).imageRootDir;")).toBe(
    "/Users/me/blog",
  );

  // Front matter typora-root-url overrides the setting.
  const withFm = "---\ntypora-root-url: /srv/site\n---\n\n![a](/img/a.png)\n\nend";
  await setDoc(page, withFm, withFm.length);
  await expect(widget).toHaveAttribute("data-path", "/srv/site/img/a.png");

  // Cmd+Opt+Shift+R clears the setting.
  await setDoc(page, src, src.length);
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyR`);
  await expect(page.getByTestId("status")).toHaveText("已清除圖片根目錄");
  await expect(widget).toHaveAttribute("data-path", "/img/a.png");
});
