import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, line, nextFrames, setDoc } from "./helpers";

/**
 * #54: an inline span renders as soon as its closing mark is typed (cursor
 * right after it), shows its source only with the cursor inside, and the
 * arrow keys step into it. Real keyboard input throughout.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
  await setDoc(page, "", 0);
});

async function markState(page: Page, lineNo = 1) {
  return line(page, lineNo).evaluate((el) => {
    const hidden = Array.from(el.querySelectorAll(".k-mark-hidden"));
    const clone = el.cloneNode(true) as HTMLElement;
    for (const h of Array.from(clone.querySelectorAll(".k-mark-hidden")))
      h.remove();
    return {
      hiddenCount: hidden.length,
      hiddenWidths: hidden.map((h) => h.getBoundingClientRect().width),
      shown: el.querySelectorAll(".k-mark").length,
      visibleText: clone.textContent ?? "",
    };
  });
}

const CASES = [
  { name: "emphasis", src: "*test*", cls: "k-em", text: "test" },
  { name: "strong", src: "**bold**", cls: "k-strong", text: "bold" },
  { name: "inline code", src: "`code`", cls: "k-code", text: "code" },
  { name: "strikethrough", src: "~~del~~", cls: "k-strike", text: "del" },
  { name: "link", src: "[link](https://x.y)", cls: "k-link", text: "link" },
];

for (const c of CASES) {
  test(`#54 AC: ${c.name} renders as soon as the closing mark is typed`, async ({
    page,
  }) => {
    await page.keyboard.type(c.src);
    await nextFrames(page);
    expect(await getDoc(page)).toBe(c.src);
    await expect(line(page, 1).locator(`.${c.cls}`)).toHaveText(c.text);
    const s = await markState(page);
    expect(s.shown).toBe(0);
    expect(s.hiddenCount).toBeGreaterThan(0);
    for (const w of s.hiddenWidths) expect(w).toBeLessThan(0.5);
    expect(s.visibleText).toBe(c.text);

    // One step left: into the span → source shows; one step right: hidden again.
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => (await markState(page)).shown)
      .toBeGreaterThan(0);
    expect((await markState(page)).visibleText).toBe(c.src);
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await markState(page)).shown).toBe(0);
    expect((await markState(page)).visibleText).toBe(c.text);
  });
}

test("#54 AC: CJK mixed `中文**粗體**中文` renders right after `**`", async ({
  page,
}) => {
  await page.keyboard.type("中文**粗體**");
  await expect(line(page, 1).locator(".k-strong")).toHaveText("粗體");
  expect((await markState(page)).visibleText).toBe("中文粗體");
  await page.keyboard.type("中文");
  expect((await markState(page)).visibleText).toBe("中文粗體中文");
  expect(await getDoc(page)).toBe("中文**粗體**中文");
});

test("#54 Backspace right after a rendered span expands it first, then deletes", async ({
  page,
}) => {
  await page.keyboard.type("**bold**");
  await expect.poll(async () => (await markState(page)).shown).toBe(0);
  await page.keyboard.press("Backspace");
  expect(await getDoc(page)).toBe("**bold**");
  await expect
    .poll(async () => (await markState(page)).shown)
    .toBeGreaterThan(0);
  await page.keyboard.press("Backspace");
  expect(await getDoc(page)).toBe("**bold*");
});

test("#54 an image renders after `)`; ArrowLeft steps into its source", async ({
  page,
}) => {
  await page.keyboard.type("![alt](https://example.test/a.png)");
  expect(await getDoc(page)).toBe("![alt](https://example.test/a.png)");
  await expect(page.getByTestId("image-widget")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("image-widget")).toHaveCount(0);
  await expect(line(page, 1)).toContainText(
    "![alt](https://example.test/a.png)",
  );
  const head = await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    return app.editor.view.state.selection.main.head;
  });
  expect(head).toBe("![alt](https://example.test/a.png)".length - 1);
  await page.keyboard.press("End");
  await expect(page.getByTestId("image-widget")).toHaveCount(1);
});

test("#54 decorations stay frozen while composing right after a span", async ({
  page,
}) => {
  await page.keyboard.type("**bold**");
  await expect.poll(async () => (await markState(page)).shown).toBe(0);
  const before = await markState(page);
  const cdp = await page.context().newCDPSession(page);
  for (const step of ["z", "zh", "中"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await nextFrames(page);
    expect((await markState(page)).hiddenCount).toBe(before.hiddenCount);
  }
  await cdp.send("Input.insertText", { text: "中" });
  await nextFrames(page, 4);
  expect(await getDoc(page)).toBe("**bold**中");
  expect((await markState(page)).shown).toBe(0);
});
