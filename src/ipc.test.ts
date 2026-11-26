import { beforeEach, describe, expect, it } from "vitest";
import {
  type AppError,
  clearRecovery,
  createFile,
  DEFAULT_SETTINGS,
  type FsChangedPayload,
  getSettings,
  listFiles,
  listMarkdownPaths,
  listRecovery,
  listThemes,
  onFsChanged,
  openFile,
  readThemeCss,
  readTree,
  renamePath,
  resetMockState,
  saveFile,
  seedMockCustomTheme,
  seedMockDir,
  seedMockFile,
  seedMockUploadSettings,
  setSettings,
  trashPath,
  triggerMockFsChanged,
  watchFolder,
  writeRecovery,
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
      codeLineNumbers: true,
      mathAutoNumber: true,
      imageRootDir: "/tmp/kalamos-test/blog",
    };
    await setSettings(updated);
    // Fields absent from older settings files get their defaults.
    expect(await getSettings()).toEqual({
      ...updated,
      systemDarkTheme: "melan",
      focusMode: false,
      typewriterMode: false,
      uploadCommand: null,
      uploadArgs: [],
      uploadOnInsert: false,
      autoPairBrackets: true,
      autoPairMarkdown: false,
      startupBehavior: "restoreFolder",
      autoSave: true,
      autoCheckUpdates: true,
      fontSize: 17,
      contentWidth: 720,
      recentFiles: [],
    });

    await setSettings({ ...updated, focusMode: true, typewriterMode: true });
    expect(await getSettings()).toMatchObject({
      focusMode: true,
      typewriterMode: true,
    });

    // #104: listMarkdownPaths lists only Markdown files and skips hidden/node_modules.
    seedMockDir("/tmp/kalamos-test/qo");
    seedMockFile("/tmp/kalamos-test/qo/a.md", "# A");
    seedMockFile("/tmp/kalamos-test/qo/sub/b.markdown", "# B");
    seedMockFile("/tmp/kalamos-test/qo/.hidden/c.md", "# Hidden");
    seedMockFile("/tmp/kalamos-test/qo/node_modules/pkg/d.md", "# Pkg");
    seedMockFile("/tmp/kalamos-test/qo/notes.txt", "txt");
    const listed = await listMarkdownPaths("/tmp/kalamos-test/qo");
    expect(listed).toEqual({
      paths: [
        "/tmp/kalamos-test/qo/a.md",
        "/tmp/kalamos-test/qo/sub/b.markdown",
      ],
      truncated: false,
    });

    // IM-05: the app can never set the upload command / args (only the file can)…
    await setSettings({
      ...updated,
      uploadCommand: "/bin/sh",
      uploadArgs: ["-c", "touch /tmp/kalamos-test/pwned"],
      uploadOnInsert: true,
    });
    expect(await getSettings()).toMatchObject({
      uploadCommand: null,
      uploadArgs: [],
      uploadOnInsert: true,
    });
    // …and app writes keep what the user put in the file.
    seedMockUploadSettings("/tmp/kalamos-test/bin/picgo", ["upload"]);
    await setSettings({
      ...(await getSettings()),
      uploadCommand: null,
      uploadArgs: [],
      theme: "papyros",
    });
    expect(await getSettings()).toMatchObject({
      theme: "papyros",
      uploadCommand: "/tmp/kalamos-test/bin/picgo",
      uploadArgs: ["upload"],
    });
  });

  it("preloads /demo folder with mixed CJK/English, H1-H6 headings, and a subfolder", async () => {
    const tree = await readTree("/demo");
    expect(tree.kind).toBe("dir");
    expect(tree.path).toBe("/demo");
    expect(tree.children).toBeDefined();

    // First child is subfolder "guides", followed by markdown files
    expect(tree.children![0].kind).toBe("dir");
    expect(tree.children![0].name).toBe("guides");
    expect(tree.children![0].children).toHaveLength(1);
    expect(tree.children![0].children![0].path).toBe(
      "/demo/guides/shortcuts.md",
    );

    const welcomeContent = await openFile("/demo/welcome.md");
    for (const prefix of ["# ", "## ", "### ", "#### ", "##### ", "###### "]) {
      expect(welcomeContent).toContain(prefix);
    }
  });

  it("readTree filters hidden, .git, node_modules, non-md files and sorts dirs first then case-insensitive", async () => {
    seedMockDir("/work/.git");
    seedMockFile("/work/.git/config.md", "# git");
    seedMockFile("/work/node_modules/pkg/readme.md", "# npm");
    seedMockFile("/work/.hidden.md", "# hidden");
    seedMockFile("/work/photo.png", "binary");
    seedMockDir("/work/zeta");
    seedMockDir("/work/Alpha");
    seedMockFile("/work/Alpha/doc.MARKDOWN", "# Doc");
    seedMockFile("/work/beta.md", "# Beta");
    seedMockFile("/work/apple.md", "# Apple");
    seedMockFile("/work/Banana.markdown", "# Banana");

    const tree = await readTree("/work");
    expect(tree.children?.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "dir:Alpha",
      "dir:zeta",
      "file:apple.md",
      "file:Banana.markdown",
      "file:beta.md",
    ]);
  });

  it("listFiles sorts by mtimeMs desc and truncates excerpt to 120 chars without breaking CJK", async () => {
    const longCjk = `\n\n  # ${"蘆葦筆莎草紙".repeat(25)}結尾`;
    seedMockFile("/vault/older.md", "# 舊筆記\n第二行", 1000);
    seedMockFile("/vault/sub/newer.md", longCjk, 2000);

    const files = await listFiles("/vault");
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/vault/sub/newer.md");
    expect(Array.from(files[0].excerpt)).toHaveLength(120);
    expect(files[1].path).toBe("/vault/older.md");
    expect(files[1].excerpt).toBe("# 舊筆記");
  });

  it("supports createFile (with AlreadyExists error), renamePath, trashPath, watchFolder, and onFsChanged", async () => {
    const created = await createFile("/demo/created.md");
    expect(created.path).toBe("/demo/created.md");
    expect(created.size).toBe(0);

    await expect(createFile("/demo/created.md")).rejects.toMatchObject({
      kind: "AlreadyExists",
    } satisfies Partial<AppError>);

    await renamePath("/demo/created.md", "/demo/renamed.md");
    await expect(openFile("/demo/created.md")).rejects.toMatchObject({
      kind: "NotFound",
    } satisfies Partial<AppError>);
    expect(await openFile("/demo/renamed.md")).toBe("");

    await trashPath("/demo/renamed.md");
    await expect(openFile("/demo/renamed.md")).rejects.toMatchObject({
      kind: "NotFound",
    } satisfies Partial<AppError>);

    await watchFolder("/demo");
    const received: FsChangedPayload[] = [];
    const unlisten = await onFsChanged((payload) => {
      received.push(payload);
    });
    await triggerMockFsChanged({ root: "/demo", paths: ["/demo/welcome.md"] });
    expect(received).toEqual([{ root: "/demo", paths: ["/demo/welcome.md"] }]);
    unlisten();
  });

  it("lists built-in and custom themes and reads custom theme CSS with path validation", async () => {
    const themes = await listThemes();
    expect(themes).toEqual([
      { id: "papyros", name: "Papyros", builtin: true },
      { id: "melan", name: "Melan", builtin: true },
      { id: "nyx", name: "Nyx", builtin: true },
      { id: "custom:night", name: "night", builtin: false },
    ]);

    const nightCss = await readThemeCss("custom:night");
    expect(nightCss).toContain("--k-bg");

    seedMockCustomTheme("amber", ":root { --k-accent: #d98a63; }");
    const updatedThemes = await listThemes();
    expect(updatedThemes.map((t) => t.id)).toEqual([
      "papyros",
      "melan",
      "nyx",
      "custom:amber",
      "custom:night",
    ]);

    await expect(readThemeCss("papyros")).rejects.toMatchObject({
      kind: "InvalidPath",
    } satisfies Partial<AppError>);
    await expect(readThemeCss("nyx")).rejects.toMatchObject({
      kind: "InvalidPath",
    } satisfies Partial<AppError>);
    await expect(readThemeCss("custom:../escape")).rejects.toMatchObject({
      kind: "InvalidPath",
    } satisfies Partial<AppError>);
    await expect(readThemeCss("custom:missing")).rejects.toMatchObject({
      kind: "NotFound",
    } satisfies Partial<AppError>);
  });
});
