import { editor, expect, seedDocument, start, test } from "./fixtures";

for (const width of [1360, 390]) {
  test(`the workspace stays in place when file actions open at ${width}px`, async ({
    page,
    request,
    name,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const path = `${name}/01 - A research note with a long descriptive name.md`;
    await seedDocument(request, path, "# Research note\n\n中文 and English");
    await start(page);
    const sidebar = page.locator("#workspace-sidebar");
    const sidebarToggle = page.locator("#toggle-sidebar");
    if (width === 390) {
      await expect(sidebar).toBeHidden();
      await sidebarToggle.press("Enter");
    }
    const item = sidebar
      .getByRole("button", {
        name: "01 - A research note with a long descriptive name.md",
        exact: true,
      })
      .and(sidebar.getByTitle(path, { exact: true }));
    await item.click();
    await expect(item).toHaveAttribute("aria-current", "true");
    expect(
      await item.evaluate((node) => getComputedStyle(node).whiteSpace),
    ).toBe("nowrap");
    await editor(page).waitFor();
    await sidebarToggle.press("Enter");
    await expect(sidebar).toBeHidden();
    const before = await editor(page).boundingBox();
    const actionsTrigger = page.locator("#file-actions-trigger");
    const triggerBounds = await actionsTrigger.boundingBox();
    expect(triggerBounds).not.toBeNull();
    expect(
      (triggerBounds?.x ?? 0) + (triggerBounds?.width ?? 0),
    ).toBeLessThanOrEqual(width);
    expect(before?.x).toBeGreaterThanOrEqual(0);
    const actions = page.locator("#file-actions");
    await actionsTrigger.press("Enter");
    await expect(actions).toBeVisible();
    await expect(actionsTrigger).toHaveAttribute("aria-expanded", "true");
    expect(await editor(page).boundingBox()).toEqual(before);
    const items = actions.getByRole("button");
    await items.first().focus();
    await page.keyboard.press("Escape");
    await expect(actions).toBeHidden();
    await expect(actionsTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(actionsTrigger).toBeFocused();
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(horizontalOverflow).toBe(false);
  });
}
