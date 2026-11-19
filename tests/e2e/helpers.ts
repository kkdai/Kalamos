import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for the Kalamos e2e suite.
 *
 * The app runs in a plain browser, so src/ipc.ts uses its in-memory mock.
 * We reach the mock and the app object with dynamic imports of the same
 * Vite module URLs the page already loaded (module instances are shared).
 */

export const MOD = "ControlOrMeta";

export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__kalamos));
  await page.waitForFunction(async () => {
    const main = await import("/src/main.ts" as string);
    return Boolean(main.getActiveApp());
  });
  // Let init() (settings / theme menu / sidebar / recovery) settle.
  await page.waitForTimeout(100);
}

/** Replace the whole document (as if a file had been opened) and focus it. */
export async function setDoc(page: Page, content: string, cursor = 0): Promise<void> {
  await page.evaluate(
    async ({ content, cursor }) => {
      const main = await import("/src/main.ts" as string);
      const app = main.getActiveApp();
      app.editor.setContent(content, { dirty: false });
      app.editor.setCursor(cursor);
      app.editor.view.focus();
    },
    { content, cursor },
  );
  await nextFrames(page);
}

export async function getDoc(page: Page): Promise<string> {
  return page.evaluate(() => window.__kalamos!.getDoc());
}

export async function setCursor(page: Page, pos: number): Promise<void> {
  await page.evaluate((p) => window.__kalamos!.setCursor(p), pos);
  await nextFrames(page);
}

export async function getSelection(page: Page): Promise<{ anchor: number; head: number }> {
  return page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    const sel = main.getActiveApp().editor.view.state.selection.main;
    return { anchor: sel.anchor, head: sel.head };
  });
}

export async function selectRange(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    async ({ from, to }) => {
      const main = await import("/src/main.ts" as string);
      const view = main.getActiveApp().editor.view;
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to } });
    },
    { from, to },
  );
  await nextFrames(page);
}

export async function nextFrames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/** Element width collapsed (k-mark-hidden uses font-size: 0). */
export async function isCollapsed(page: Page, selector: string, index = 0): Promise<boolean> {
  return page.evaluate(
    ({ selector, index }) => {
      const el = document.querySelectorAll(selector)[index] as HTMLElement | undefined;
      if (!el) return false;
      return el.getBoundingClientRect().width < 0.5;
    },
    { selector, index },
  );
}

/** Text of a given 1-based editor line as rendered (.cm-line). */
export function line(page: Page, n: number) {
  return page.locator(".cm-content .cm-line").nth(n - 1);
}

export async function editorLocator(page: Page) {
  const ed = page.getByTestId("editor");
  await expect(ed).toBeVisible();
  return ed;
}

/** Run code against the mock IPC module inside the page. */
export async function withIpc<T>(
  page: Page,
  fn: string,
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const ipc = await import("/src/ipc.ts" as string);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const f = new Function("ipc", "arg", `return (async () => { ${fn} })();`);
      return f(ipc, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}
