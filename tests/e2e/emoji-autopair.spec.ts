import { expect, test } from "@playwright/test";
import { MOD, boot, getDoc, nextFrames, setDoc, withIpc } from "./helpers";

/** Issues #17 (ED-08 emoji autocomplete) and #18 (ED-09 auto-pairing). */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("#17 AC: typing :smile shows the candidate list; Enter inserts 😄", async ({ page }) => {
  await setDoc(page, "今天 ", "今天 ".length);
  await page.keyboard.type(":smile");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  const first = popup.locator("li").first();
  await expect(first).toContainText(":smile:");
  await expect(first.getByTestId("emoji-option")).toHaveText("😄");
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
  expect(await getDoc(page)).toBe("今天 😄");
});

test("#17 spec: typing <di shows no HTML tag completion", async ({ page }) => {
  await setDoc(page, "段落 ", "段落 ".length);
  await page.keyboard.type("<di");
  await page.waitForTimeout(400);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  expect(await getDoc(page)).toBe("段落 <di");
});

test("#17 spec: a full :smile: converts; no popup inside code or after digits", async ({ page }) => {
  await setDoc(page, "", 0);
  await page.keyboard.type("讚 :+1: 時間 12:30");
  await nextFrames(page, 4);
  expect(await getDoc(page)).toBe("讚 👍 時間 12:30");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);

  await setDoc(page, "`code ` 後", 6);
  await page.keyboard.type(":smile");
  await page.waitForTimeout(300);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
});

test("#18 AC: brackets pair by default; with the setting off typing ( inserts only (", async ({ page }) => {
  await setDoc(page, "", 0);
  await page.keyboard.type("(");
  expect(await getDoc(page)).toBe("()");
  await page.keyboard.type("a)");
  expect(await getDoc(page)).toBe("(a)");

  await page.keyboard.press(`${MOD}+Alt+KeyP`);
  await expect(page.getByTestId("status")).toHaveText("自動配對括號：關");
  expect(await withIpc<boolean>(page, "return (await ipc.getSettings()).autoPairBrackets;")).toBe(false);
  await setDoc(page, "", 0);
  await page.keyboard.type("(「[\"");
  expect(await getDoc(page)).toBe("(「[\"");

  await page.keyboard.press(`${MOD}+Alt+KeyP`);
  await expect(page.getByTestId("status")).toHaveText("自動配對括號：開");
});

test("#18 spec: Markdown symbols pair only when enabled (Cmd+Opt+Shift+P)", async ({ page }) => {
  await setDoc(page, "a ", 2);
  await page.keyboard.type("*");
  expect(await getDoc(page)).toBe("a *");
  await page.keyboard.press(`${MOD}+Alt+Shift+KeyP`);
  await expect(page.getByTestId("status")).toHaveText("自動配對 Markdown 符號：開");
  await setDoc(page, "a ", 2);
  await page.keyboard.type("**粗體**");
  expect(await getDoc(page)).toBe("a **粗體**");
});

test("#18 spec: 「 committed through IME composition is inserted once, never duplicated", async ({ page }) => {
  await setDoc(page, "他說", 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "「", selectionStart: 1, selectionEnd: 1 });
  await nextFrames(page);
  await cdp.send("Input.insertText", { text: "「" });
  await nextFrames(page, 4);
  const doc = await getDoc(page);
  expect(doc.startsWith("他說「")).toBe(true);
  expect(doc.split("「").length - 1).toBe(1);
  expect(doc === "他說「" || doc === "他說「」").toBe(true);
  // Typing the content and the closer afterwards never doubles the closer.
  await page.keyboard.type("好");
  await cdp.send("Input.insertText", { text: "」" });
  await nextFrames(page, 4);
  expect((await getDoc(page)).split("」").length - 1).toBe(1);
});
