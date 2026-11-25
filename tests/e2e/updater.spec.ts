import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames, setDoc } from "./helpers";

async function menuAction(page: Page, action: string): Promise<void> {
  await page.evaluate(async (act) => {
    const ipc = await import("/src/ipc.ts" as string);
    await ipc.emitMockMenuAction(act, null);
  }, action);
  await nextFrames(page);
}

test.describe("#91 in-app auto-updater", () => {
  test("up-to-date flow: manual check reports already on latest version", async ({
    page,
  }) => {
    await boot(page);
    await page.evaluate(async () => {
      const ipc = await import("/src/ipc.ts" as string);
      ipc.setMockUpdateHandler(async () => null);
    });

    await menuAction(page, "app.checkForUpdates");

    const dialog = page.getByTestId("update-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-state", "upToDate");
    await expect(page.getByTestId("update-status-message")).toHaveText(
      "目前使用的已是最新版本。",
    );

    await page.getByTestId("update-close").click();
    await expect(dialog).toHaveCount(0);
  });

  test("update available → approve → download progress → settle unsaved changes → install & restart", async ({
    page,
  }) => {
    await boot(page);

    // Create an unsaved untitled document so the #81 unsaved flow is exercised.
    await setDoc(page, "# Draft before update", 21);
    await page.keyboard.insertText("!");
    await expect.poll(() => getDoc(page)).toBe("# Draft before update!");

    await page.evaluate(async () => {
      const ipc = await import("/src/ipc.ts" as string);
      const state = { downloaded: false, installed: false };
      (window as unknown as { __updateState: typeof state }).__updateState =
        state;

      ipc.setMockDialogHandlers({
        saveChanges: () => "save",
        save: () => "/demo/updated-draft.md",
      });

      ipc.setMockUpdateHandler(async () => ({
        version: "0.8.0",
        currentVersion: "0.7.0",
        body: "### 新功能\n\n- **自動更新**：支援應用程式內更新。\n- 安全純文字渲染 `<script>alert(1)</script>`",
        download: async (onEvent) => {
          onEvent?.({ event: "Started", data: { contentLength: 2048 } });
          await new Promise((r) => setTimeout(r, 40));
          onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
          await new Promise((r) => setTimeout(r, 40));
          onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
          onEvent?.({ event: "Finished" });
          state.downloaded = true;
        },
        install: async () => {
          state.installed = true;
        },
        close: async () => {},
      }));
    });

    await menuAction(page, "app.checkForUpdates");

    const dialog = page.getByTestId("update-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-state", "available");
    await expect(dialog).toContainText("Kalamos 0.8.0");
    const notes = page.getByTestId("update-release-notes");
    await expect(notes).toContainText("自動更新");
    await expect(notes.locator("script")).toHaveCount(0);

    // Approve update
    await page.getByTestId("update-now").click();

    // Wait for download → save prompt → install → restart
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const ipc = await import("/src/ipc.ts" as string);
          const state = (
            window as unknown as {
              __updateState: { downloaded: boolean; installed: boolean };
            }
          ).__updateState;
          return {
            downloaded: state.downloaded,
            installed: state.installed,
            restarts: ipc.getMockRestartCount(),
            savedContent: ipc.readMockFile("/demo/updated-draft.md"),
          };
        }),
      )
      .toEqual({
        downloaded: true,
        installed: true,
        restarts: 1,
        savedContent: "# Draft before update!",
      });
  });

  test("manual check failure shows localized error message with expandable technical details", async ({
    page,
  }) => {
    await boot(page);
    await page.evaluate(async () => {
      const ipc = await import("/src/ipc.ts" as string);
      let calls = 0;
      ipc.setMockUpdateHandler(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            "Could not fetch a valid release JSON from the remote",
          );
        }
        return null;
      });
    });

    await menuAction(page, "app.checkForUpdates");

    const dialog = page.getByTestId("update-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("update-error-message")).toHaveText(
      "目前無法取得更新資訊，請檢查網路連線後再試一次。",
    );

    const details = page.getByTestId("update-error-details");
    await expect(details).toBeVisible();
    await expect(details).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("update-error-detail")).toBeHidden();

    await page.getByTestId("update-error-details-summary").click();
    await expect(page.getByTestId("update-error-detail")).toBeVisible();
    await expect(page.getByTestId("update-error-detail")).toHaveText(
      "Could not fetch a valid release JSON from the remote",
    );

    await page.getByTestId("update-retry").click();
    await expect(dialog).toHaveAttribute("data-state", "upToDate");
    await page.getByTestId("update-close").click();
    await expect(dialog).toHaveCount(0);
  });

  test("preferences general tab exposes autoCheckUpdates toggle (enabled by default)", async ({
    page,
  }) => {
    await boot(page);
    await page.keyboard.press(`${MOD}+Comma`);

    const checkbox = page.getByTestId("pref-auto-check-updates");
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const ipc = await import("/src/ipc.ts" as string);
          return (await ipc.getSettings()).autoCheckUpdates;
        }),
      )
      .toBe(false);
  });
});
