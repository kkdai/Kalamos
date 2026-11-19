import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecovery,
  DEFAULT_SETTINGS,
  getSettings,
  listRecovery,
  openFile,
  resetMockState,
  saveFile,
  setSettings,
  writeRecovery,
  type AppError,
} from "./ipc";

describe("ipc in-memory mock (api.yaml contract)", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("saves and opens files preserving exact CRLF, no trailing newline, and Chinese UTF-8 bytes", async () => {
    const content = "# 蘆葦筆 Kalamos\r\n\r\n中英混寫 **粗體**，最後一行無換行";
    const expectedBytes = new TextEncoder().encode(content).byteLength;

    const meta = await saveFile("/tmp/notes/a.md", content);
    expect(meta.path).toBe("/tmp/notes/a.md");
    expect(meta.size).toBe(expectedBytes);
    expect(meta.mtimeMs).toBeGreaterThan(0);

    const loaded = await openFile("/tmp/notes/a.md");
    expect(loaded).toBe(content);
  });

  it("rejects open_file and save_file with AppError matching api.yaml", async () => {
    await expect(openFile("/tmp/missing.md")).rejects.toMatchObject({
      kind: "NotFound",
    } satisfies Partial<AppError>);

    await expect(openFile("")).rejects.toMatchObject({
      kind: "InvalidPath",
    } satisfies Partial<AppError>);

    await expect(saveFile("   ", "hello")).rejects.toMatchObject({
      kind: "InvalidPath",
    } satisfies Partial<AppError>);
  });

  it("manages recovery entries sorted newest-first and clears them", async () => {
    expect(await listRecovery()).toEqual([]);

    await writeRecovery("doc-1", "# Untitled 1", null);
    await writeRecovery("doc-2", "# Named 2\r\nLine 2", "/tmp/notes/b.md");

    const list = await listRecovery();
    expect(list).toHaveLength(2);
    expect(list[0].docId).toBe("doc-2");
    expect(list[0].path).toBe("/tmp/notes/b.md");
    expect(list[0].content).toBe("# Named 2\r\nLine 2");
    expect(list[1].docId).toBe("doc-1");
    expect(list[1].path).toBeNull();
    expect(list[0].savedAtMs).toBeGreaterThan(list[1].savedAtMs);

    await clearRecovery("doc-2");
    const afterClear = await listRecovery();
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0].docId).toBe("doc-1");
  });

  it("reads default settings and persists updated settings", async () => {
    const initial = await getSettings();
    expect(initial).toEqual(DEFAULT_SETTINGS);

    const updated = {
      theme: "melan",
      lastFolder: "/tmp/kalamos-test/Notes",
      sidebarVisible: true,
      sidebarTab: "outline" as const,
      sourceMode: true,
    };
    await setSettings(updated);
    expect(await getSettings()).toEqual(updated);
  });
});
