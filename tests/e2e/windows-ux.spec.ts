import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  boot,
  getDoc,
  newPlatformContext,
  nextFrames,
  selectRange,
  setDoc,
} from "./helpers";

/**
 * #89: Windows UX — shortcut labels, native-style tab bar & theme button layout,
 * keyboard shortcuts (including menu-only accelerators), close/quit unsaved-changes
 * checks (Ctrl+Q, Alt+F4, close button), backslash native paths, fonts, and LF/CRLF.
 *
 * Simulated in Playwright via `newPlatformContext(browser, "windows")`
 * (userAgent + navigator.platform + navigator.userAgentData).
 */

async function openWindowsPage(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await newPlatformContext(browser, "windows");
  const page = await ctx.newPage();
  await boot(page);
  return { ctx, page };
}

async function runWithApp<T>(
  page: Page,
  fn: string,
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const main = await import("/src/main.ts" as string);
      const ipc = await import("/src/ipc.ts" as string);
      const app = main.getActiveApp();
      return new Function(
        "app",
        "ipc",
        "arg",
        `return (async () => { ${fn} })();`,
      )(app, ipc, arg);
    },
    { fn, arg },
  );
}

test("#89 Windows shortcut labels use Ctrl/Alt/Shift everywhere with no macOS symbols", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    // Theme button tooltip.
    await expect(page.getByTestId("theme-menu-button")).toHaveAttribute(
      "title",
      "切換主題 (Ctrl+Shift+T)",
    );

    // Tab bar tooltips (visible with 2+ tabs).
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+t");
    await expect(page.getByTestId("tab-new")).toHaveAttribute(
      "title",
      "新增分頁（Ctrl+T）",
    );
    await expect(page.getByTestId("tab-close").first()).toHaveAttribute(
      "title",
      "關閉分頁（Ctrl+W）",
    );

    // Sidebar tooltips & empty hints.
    await page.keyboard.press("Control+Shift+L");
    await expect(page.getByTestId("sidebar-open-folder-btn")).toHaveAttribute(
      "title",
      "開啟資料夾 (Ctrl+Shift+O)",
    );
    await expect(page.locator(".k-sidebar-empty")).toHaveText(
      "尚未開啟資料夾（Ctrl+Shift+O）",
    );
    await page.getByTestId("sidebar-tab-search").click();
    await expect(page.getByTestId("folder-search-status")).toHaveText(
      "請先開啟資料夾（Ctrl+Shift+O）才能搜尋",
    );

    // Find & replace bar tooltips.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Alt+f");
    await expect(page.getByTestId("search-prev")).toHaveAttribute(
      "title",
      "上一個（Ctrl+Shift+G）",
    );
    await expect(page.getByTestId("search-next")).toHaveAttribute(
      "title",
      "下一個（Ctrl+G）",
    );
    await expect(page.getByTestId("replace-all")).toHaveAttribute(
      "title",
      "全部取代（Ctrl+Enter）",
    );
    await page.keyboard.press("Escape");

    // Preferences: general, editor, appearance, images — no ⌘/⌥/⇧/Cmd+/Opt+/Finder.
    await page.keyboard.press("Control+Comma");
    const prefs = page.getByTestId("preferences");
    await expect(prefs).toBeVisible();
    await expect(prefs).toContainText("從檔案總管開啟的檔案不受影響。");
    await expect(prefs).toContainText("Ctrl+S");
    await expect(prefs).not.toContainText("Finder");
    await expect(prefs).not.toContainText("Cmd+");

    for (const tab of ["editor", "appearance", "images"] as const) {
      await page.getByTestId(`pref-tab-${tab}`).click();
      const text = await prefs.innerText();
      expect(text).not.toMatch(/[⌘⌥⇧⌃]|Cmd\+|Opt\+/);
    }
    await page.getByTestId("pref-tab-editor").click();
    await expect(prefs).toContainText("Ctrl+Alt+P");
    await expect(prefs).toContainText("Ctrl+Alt+Shift+P");
    await expect(prefs).toContainText("Ctrl+Alt+L");
    await expect(prefs).toContainText("Ctrl+Alt+N");
    await page.getByTestId("pref-tab-appearance").click();
    await expect(prefs).toContainText("Ctrl+Shift+T");
    await page.getByTestId("pref-tab-images").click();
    await expect(prefs).toContainText("Ctrl+Alt+R");
    await page.keyboard.press("Escape");
  } finally {
    await ctx.close();
  }
});

test("#89 Windows tab bar, quick buttons & theme button layout: aligned with no overlap or excess gap", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    // Windows keeps top-left quick buttons with Ctrl shortcut tooltips.
    await expect(page.getByTestId("sidebar-toggle-button")).toBeVisible();
    await expect(page.getByTestId("open-file-button")).toBeVisible();
    await expect(page.getByTestId("sidebar-toggle-button")).toHaveAttribute(
      "title",
      "切換側欄 (Ctrl+Shift+L)",
    );
    await expect(page.getByTestId("open-file-button")).toHaveAttribute(
      "title",
      "開啟檔案 (Ctrl+O)",
    );

    await runWithApp(page, "app.newTab();");
    await nextFrames(page, 3);

    const measure = async () =>
      page.evaluate(() => {
        const quick = document
          .querySelector<HTMLElement>(".k-sidebar-toggle-widget")!
          .getBoundingClientRect();
        const track = document
          .querySelector<HTMLElement>(".k-tabbar-track")!
          .getBoundingClientRect();
        const newBtn = document
          .querySelector<HTMLElement>('[data-testid="tab-new"]')!
          .getBoundingClientRect();
        const themeBtn = document
          .querySelector<HTMLElement>('[data-testid="theme-menu-button"]')!
          .getBoundingClientRect();
        const sidebar = document
          .querySelector<HTMLElement>('[data-testid="sidebar"]')!
          .getBoundingClientRect();
        return { quick, track, newBtn, themeBtn, sidebar };
      });

    // Sidebar closed: quick buttons sit at top-left, tab bar starts cleanly 10px after them
    // with no overlap and no excess gap, and + button sits cleanly left of the theme button.
    const closed = await measure();
    expect(closed.quick.left).toBe(16);
    expect(closed.track.left - closed.quick.right).toBeGreaterThanOrEqual(8);
    expect(closed.track.left - closed.quick.right).toBeLessThanOrEqual(14);
    expect(closed.themeBtn.left - closed.newBtn.right).toBeGreaterThanOrEqual(
      8,
    );
    expect(closed.themeBtn.left - closed.newBtn.right).toBeLessThanOrEqual(14);
    expect(Math.abs(closed.quick.top - closed.themeBtn.top)).toBeLessThan(2);
    expect(Math.abs(closed.newBtn.top - closed.themeBtn.top)).toBeLessThan(2);

    // Sidebar open: quick buttons shift right after the sidebar, and tab bar follows 10px after them.
    await runWithApp(page, "await app.toggleSidebar();");
    await page.waitForTimeout(300);
    const open = await measure();
    expect(open.quick.left).toBeGreaterThan(open.sidebar.right);
    expect(open.track.left - open.quick.right).toBeGreaterThanOrEqual(8);
    expect(open.track.left - open.quick.right).toBeLessThanOrEqual(14);
    expect(open.themeBtn.left - open.newBtn.right).toBeGreaterThanOrEqual(8);
    expect(open.themeBtn.left - open.newBtn.right).toBeLessThanOrEqual(14);
  } finally {
    await ctx.close();
  }
});

test("#89 Windows shortcuts: headings, quote, code/math blocks, strike, outline, zoom", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    await setDoc(page, "Hello", 2);

    // Headings 1–6 and back to paragraph via Ctrl+1..6 / Ctrl+0.
    await page.keyboard.press("Control+2");
    expect(await getDoc(page)).toBe("## Hello");
    await page.keyboard.press("Control+5");
    expect(await getDoc(page)).toBe("##### Hello");
    await page.keyboard.press("Control+0");
    expect(await getDoc(page)).toBe("Hello");

    // Blockquote via Ctrl+Alt+Q.
    await page.keyboard.press("Control+Alt+q");
    expect(await getDoc(page)).toBe("> Hello");
    await page.keyboard.press("Control+Alt+q");
    expect(await getDoc(page)).toBe("Hello");

    // Strikethrough via Ctrl+Shift+D.
    await selectRange(page, 0, 5);
    await page.keyboard.press("Control+Shift+d");
    expect(await getDoc(page)).toBe("~~Hello~~");

    // Outline toggle via Ctrl+Shift+1 (must not trigger Heading 1!).
    await page.keyboard.press("Control+Shift+1");
    await expect(page.getByTestId("sidebar")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(await runWithApp<string>(page, "return app.sidebar.getTab();")).toBe(
      "outline",
    );
    expect(await getDoc(page)).toBe("~~Hello~~");

    // Zoom via Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0.
    await page.keyboard.press("Control+Shift+Equal");
    expect(await runWithApp<number>(page, "return ipc.getMockZoom();")).toBe(
      1.1,
    );
    await page.keyboard.press("Control+Shift+Minus");
    await page.keyboard.press("Control+Shift+Minus");
    expect(await runWithApp<number>(page, "return ipc.getMockZoom();")).toBe(
      0.9,
    );
    await page.keyboard.press("Control+Shift+0");
    expect(await runWithApp<number>(page, "return ipc.getMockZoom();")).toBe(1);
  } finally {
    await ctx.close();
  }
});

test("Ctrl+wheel zooms the interface without scrolling the editor", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    await setDoc(
      page,
      "A paragraph to make the editor scrollable.\n\n".repeat(100),
    );
    const scroller = page.locator(".cm-scroller");
    const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
    await scroller.hover();
    expect(await scrollTop()).toBe(0);

    const zoom = () => runWithApp<number>(page, "return ipc.getMockZoom();");
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 100);
    await expect.poll(zoom).toBe(0.9);
    await nextFrames(page);
    expect(await scrollTop()).toBe(0);
    await page.mouse.wheel(0, -100);
    await expect.poll(zoom).toBe(1);
    await page.keyboard.up("Control");
    expect(await scrollTop()).toBe(0);

    await page.mouse.wheel(0, 100);
    await expect.poll(scrollTop).toBeGreaterThan(0);
    expect(await zoom()).toBe(1);
  } finally {
    await ctx.close();
  }
});

test("#89 Windows close & quit checks all tabs' unsaved changes for Ctrl+Q, Alt+F4, and close button", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    await page.locator(".cm-content").click();
    await page.keyboard.type("draft one");
    await page.keyboard.press("Control+t");
    await page.keyboard.type("draft two");

    // 1. Ctrl+Q with cancel keeps the app open and lists every unsaved tab.
    await runWithApp(
      page,
      "ipc.setMockDialogHandlers({ saveChanges: () => 'cancel' });",
    );
    await page.keyboard.press("Control+q");
    await nextFrames(page, 3);
    expect(
      await runWithApp<number>(page, "return ipc.getMockQuitCount();"),
    ).toBe(0);
    expect(
      await runWithApp<string[]>(
        page,
        "return ipc.getMockSaveChangesPrompts();",
      ),
    ).toEqual([
      "以下 2 份文件有未儲存的變更：\n・未命名\n・未命名 2\n\n要在關閉前儲存嗎？",
    ]);

    // 2. Window close button (onCloseRequested) with cancel keeps window open.
    expect(
      await runWithApp<boolean>(
        page,
        "return ipc.triggerMockCloseRequested();",
      ),
    ).toBe(false);
    await expect(page.getByTestId("tab")).toHaveCount(2);

    // 3. Alt+F4 with cancel keeps app open, then with discard quits.
    await page.keyboard.press("Alt+F4");
    await nextFrames(page, 3);
    expect(
      await runWithApp<number>(page, "return ipc.getMockQuitCount();"),
    ).toBe(0);

    await runWithApp(
      page,
      "ipc.setMockDialogHandlers({ saveChanges: () => 'discard' });",
    );
    await page.keyboard.press("Alt+F4");
    await expect
      .poll(() => runWithApp<number>(page, "return ipc.getMockQuitCount();"))
      .toBe(1);
  } finally {
    await ctx.close();
  }
});

test("#89 Windows native backslash paths, font stacks, and LF/CRLF line endings", async ({
  browser,
}) => {
  const { ctx, page } = await openWindowsPage(browser);
  try {
    // 1. Colliding tab labels & tooltips display Windows backslashes.
    await runWithApp(
      page,
      `ipc.seedMockFile('C:/work/alpha/docs/README.md', '# Alpha\\r\\nline two');
       ipc.seedMockFile('C:/work/beta/docs/README.md', '# Beta\\nline two');
       await app.openDocument('C:/work/alpha/docs/README.md');
       await app.openDocument('C:/work/beta/docs/README.md');`,
    );
    const tabs = page.getByTestId("tab");
    await expect(tabs).toHaveText([
      "README.md — alpha\\docs",
      "README.md — beta\\docs",
    ]);
    await expect(tabs.nth(0)).toHaveAttribute(
      "title",
      "C:\\work\\alpha\\docs\\README.md",
    );
    await expect(tabs.nth(1)).toHaveAttribute(
      "title",
      "C:\\work\\beta\\docs\\README.md",
    );

    // 2. Sidebar folder title tooltip and folder search relative dir use backslashes.
    await runWithApp(
      page,
      `ipc.seedMockFile('C:/work/alpha/guides/sub/tip.md', 'needle here');
       await app.openFolder('C:/work/alpha');`,
    );
    await expect(page.getByTestId("sidebar-folder-title")).toHaveAttribute(
      "title",
      "C:\\work\\alpha",
    );
    await page.getByTestId("sidebar-tab-search").click();
    await page.getByTestId("folder-search-input").fill("needle");
    await page.getByTestId("folder-search-input").press("Enter");
    await expect(page.locator(".k-folder-search-file-dir").first()).toHaveText(
      "guides\\sub",
    );
    await expect(
      page.getByTestId("folder-search-file").first(),
    ).toHaveAttribute("title", "C:\\work\\alpha\\guides\\sub\\tip.md");

    // 3. Preferences image root and export status messages display backslashes.
    await runWithApp(
      page,
      "await app.setImageRootDir('C:/work/assets'); await app.preferences.open('images');",
    );
    await expect(page.getByTestId("pref-image-root")).toHaveText(
      "C:\\work\\assets",
    );
    await page.keyboard.press("Escape");

    await runWithApp(
      page,
      "await app.exportDocumentAs('docx', 'C:/work/Report.docx');",
    );
    await expect(page.getByTestId("status")).toHaveText(
      "已匯出 DOCX：C:\\work\\Report.docx",
    );

    // 4. Font stacks include Windows CJK & Latin fallbacks.
    const fonts = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        body: cs.getPropertyValue("--k-font-body"),
        ui: cs.getPropertyValue("--k-font-ui"),
        mono: cs.getPropertyValue("--k-font-mono"),
      };
    });
    expect(fonts.body).toContain("Microsoft JhengHei UI");
    expect(fonts.ui).toContain("Segoe UI");
    expect(fonts.ui).toContain("Microsoft JhengHei UI");
    expect(fonts.mono).toContain("Cascadia");
    expect(fonts.mono).toContain("Consolas");

    // 5. Existing CRLF file keeps CRLF; new file uses LF.
    await tabs.nth(0).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("third");
    expect(await getDoc(page)).toContain("\r\n");

    await page.keyboard.press("Control+t");
    await page.keyboard.type("line1");
    await page.keyboard.press("Enter");
    await page.keyboard.type("line2");
    expect(await getDoc(page)).toBe("line1\nline2");
  } finally {
    await ctx.close();
  }
});
