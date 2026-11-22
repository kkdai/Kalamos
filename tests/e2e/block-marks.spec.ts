import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, line, nextFrames, setDoc } from "./helpers";

/**
 * #49: block markers render like Typora while typing (real keyboard input),
 * and Enter / Backspace leave lists and quotes with correct Markdown.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
  await setDoc(page, "", 0);
});

/** Rendered width of every hidden marker on a line (must all be ~0). */
async function hiddenMarkWidths(page: Page, lineNo: number): Promise<number[]> {
  return line(page, lineNo)
    .locator(".k-mark-hidden")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
}

/** Visible text of a line, excluding collapsed (hidden) markers. */
async function visibleText(page: Page, lineNo: number): Promise<string> {
  return line(page, lineNo).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const hidden of Array.from(clone.querySelectorAll(".k-mark-hidden")))
      hidden.remove();
    return clone.textContent ?? "";
  });
}

test("#49 AC: `- ` becomes a bullet at once and stays one while typing", async ({
  page,
}) => {
  await page.keyboard.type("- ");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(1);
  await page.keyboard.type("item");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveText("•");
  expect(await visibleText(page, 1)).toBe("• item");
  expect(await getDoc(page)).toBe("- item");
  // Moving onto the marker shows the source `-`.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(0);
  expect(await visibleText(page, 1)).toBe("- item");
});

test("#49 AC: ordered, task, heading and quote render while typing", async ({
  page,
}) => {
  await page.keyboard.type("1. first");
  await expect(line(page, 1).locator(".k-list-marker")).toHaveText("1.");
  await expect(line(page, 1).locator(".k-mark")).toHaveCount(0);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] task");
  await expect(page.locator(".cm-content input.k-task-checkbox")).toHaveCount(
    1,
  );
  // Checkbox (an <input>, no text) + the separating space + text; no `- [ ]`.
  expect(await visibleText(page, 3)).toBe(" task");

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## heading");
  await expect(line(page, 5).locator(".k-h2")).toHaveText("heading");
  expect(await visibleText(page, 5)).toBe("heading");
  for (const w of await hiddenMarkWidths(page, 5)) expect(w).toBeLessThan(0.5);

  await page.keyboard.press("Enter");
  await page.keyboard.type("> quote");
  await expect(line(page, 6)).toHaveClass(/k-quote-line/);
  expect(await visibleText(page, 6)).toBe("quote");

  expect(await getDoc(page)).toBe(
    "1. first\n\n- [ ] task\n\n## heading\n> quote",
  );
});

test("#49 AC: Enter on an empty item ends the list with a blank line", async ({
  page,
}) => {
  await page.keyboard.type("- item one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("item two");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after list");
  expect(await getDoc(page)).toBe("- item one\n- item two\n\nafter list");
  await expect(line(page, 4)).toHaveText("after list");
  await expect(line(page, 4).locator(".k-bullet-marker")).toHaveCount(0);
});

test("#49 AC: Enter on an empty quote line leaves the quote", async ({
  page,
}) => {
  await page.keyboard.type("> quote");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after quote");
  expect(await getDoc(page)).toBe("> quote\n\nafter quote");
  await expect(line(page, 3)).not.toHaveClass(/k-quote-line/);
});

test("#49 AC: ordered / task / nested lists exit level by level", async ({
  page,
}) => {
  await page.keyboard.type("1. one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after");
  expect(await getDoc(page)).toBe("1. one\n2. two\n\nafter");

  await setDoc(page, "", 0);
  await page.keyboard.type("- a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // empty nested item: out one level
  expect(await getDoc(page)).toBe("- a\n  - b\n- ");
  await page.keyboard.press("Enter"); // empty top-level item: leave the list
  await page.keyboard.type("after");
  expect(await getDoc(page)).toBe("- a\n  - b\n\nafter");
});

test("#49 AC: Backspace right after the marker makes a paragraph", async ({
  page,
}) => {
  await page.keyboard.type("- item");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  expect(await getDoc(page)).toBe("item");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(0);
});

test("#49 AC: the bullet does not flicker during IME composition", async ({
  page,
}) => {
  await page.keyboard.type("- ");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  for (const step of ["z", "zh", "zho", "中"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await nextFrames(page);
    await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(1);
  }
  await cdp.send("Input.insertText", { text: "中文" });
  await nextFrames(page, 4);
  expect(await getDoc(page)).toBe("- 中文");
  await expect(line(page, 1).locator(".k-bullet-marker")).toHaveCount(1);
});
