import { describe, expect, it } from "vitest";
import {
  addRecentFile,
  MAX_RECENT_FILES,
  recentMenuEntries,
  removeRecentFile,
  renameRecentFiles,
  sanitizeRecentFiles,
} from "./recent-files";

describe("#104 recent files helpers", () => {
  it("prepends new paths, moves duplicates to front, and caps at 20", () => {
    let list: string[] = [];
    for (let i = 0; i < 25; i++) {
      list = addRecentFile(list, `/tmp/kalamos-test/file-${i}.md`);
    }
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe("/tmp/kalamos-test/file-24.md");
    expect(list[19]).toBe("/tmp/kalamos-test/file-5.md");

    list = addRecentFile(list, "/tmp/kalamos-test/file-10.md");
    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0]).toBe("/tmp/kalamos-test/file-10.md");
    expect(
      list.filter((p) => p === "/tmp/kalamos-test/file-10.md"),
    ).toHaveLength(1);
  });

  it("removes a single file or all files under a trashed folder", () => {
    const list = [
      "/tmp/kalamos-test/a.md",
      "/tmp/kalamos-test/sub/b.md",
      "/tmp/kalamos-test/sub/deep/c.md",
      "/tmp/kalamos-test/sub-other/d.md",
    ];
    expect(removeRecentFile(list, "/tmp/kalamos-test/a.md")).toEqual([
      "/tmp/kalamos-test/sub/b.md",
      "/tmp/kalamos-test/sub/deep/c.md",
      "/tmp/kalamos-test/sub-other/d.md",
    ]);
    expect(removeRecentFile(list, "/tmp/kalamos-test/sub")).toEqual([
      "/tmp/kalamos-test/a.md",
      "/tmp/kalamos-test/sub-other/d.md",
    ]);
  });

  it("updates paths on file or folder rename and deduplicates", () => {
    const list = [
      "/tmp/kalamos-test/old/a.md",
      "/tmp/kalamos-test/old/sub/b.md",
      "/tmp/kalamos-test/new/a.md",
    ];
    expect(
      renameRecentFiles(list, "/tmp/kalamos-test/old", "/tmp/kalamos-test/new"),
    ).toEqual(["/tmp/kalamos-test/new/a.md", "/tmp/kalamos-test/new/sub/b.md"]);
  });

  it("sanitizes empty, duplicate, and oversized lists", () => {
    expect(sanitizeRecentFiles(undefined)).toEqual([]);
    expect(
      sanitizeRecentFiles([
        "",
        "  ",
        "/tmp/kalamos-test/a.md",
        "/tmp/kalamos-test/a.md",
        "/tmp/kalamos-test/b.md",
      ]),
    ).toEqual(["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/b.md"]);
  });

  it("formats menu labels and disambiguates colliding filenames per platform", () => {
    const entries = recentMenuEntries(
      [
        "/tmp/kalamos-test/unique.md",
        "/tmp/kalamos-test/alpha/docs/README.md",
        "/tmp/kalamos-test/beta/docs/README.md",
      ],
      { separator: "/" },
    );
    expect(entries).toEqual([
      { path: "/tmp/kalamos-test/unique.md", label: "unique.md" },
      {
        path: "/tmp/kalamos-test/alpha/docs/README.md",
        label: "README.md — alpha/docs",
      },
      {
        path: "/tmp/kalamos-test/beta/docs/README.md",
        label: "README.md — beta/docs",
      },
    ]);

    const winEntries = recentMenuEntries(
      ["C:/work/alpha/docs/README.md", "C:/work/beta/docs/README.md"],
      { separator: "\\" },
    );
    expect(winEntries.map((e) => e.label)).toEqual([
      "README.md — alpha\\docs",
      "README.md — beta\\docs",
    ]);
  });
});
