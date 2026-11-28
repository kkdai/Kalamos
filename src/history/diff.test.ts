import { describe, expect, it } from "vitest";
import { computeLineDiff, formatBytes, formatHistoryTimestamp } from "./diff";

describe("#148 line-level diff", () => {
  it("reports identical documents with zero additions and deletions", () => {
    const empty = computeLineDiff("", "");
    expect(empty).toEqual({
      lines: [],
      added: 0,
      removed: 0,
      identical: true,
    });

    const same = computeLineDiff("# 標題\n\n內文段落", "# 標題\n\n內文段落");
    expect(same.identical).toBe(true);
    expect(same.added).toBe(0);
    expect(same.removed).toBe(0);
    expect(same.lines).toEqual([
      { kind: "context", text: "# 標題", oldLine: 1, newLine: 1 },
      { kind: "context", text: "", oldLine: 2, newLine: 2 },
      { kind: "context", text: "內文段落", oldLine: 3, newLine: 3 },
    ]);
  });

  it("computes insertions, deletions, and replacements with accurate line numbers", () => {
    const oldText = ["alpha", "beta", "gamma", "delta"].join("\n");
    const newText = ["alpha", "BETA", "gamma", "epsilon", "delta"].join("\n");

    const diff = computeLineDiff(oldText, newText);
    expect(diff.identical).toBe(false);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(2);
    expect(diff.lines).toEqual([
      { kind: "context", text: "alpha", oldLine: 1, newLine: 1 },
      { kind: "removed", text: "beta", oldLine: 2, newLine: null },
      { kind: "added", text: "BETA", oldLine: null, newLine: 2 },
      { kind: "context", text: "gamma", oldLine: 3, newLine: 3 },
      { kind: "added", text: "epsilon", oldLine: null, newLine: 4 },
      { kind: "context", text: "delta", oldLine: 4, newLine: 5 },
    ]);
  });

  it("handles pure additions from empty and pure deletions to empty", () => {
    const added = computeLineDiff("", "line 1\nline 2");
    expect(added.added).toBe(2);
    expect(added.removed).toBe(0);
    expect(added.lines.map((l) => [l.kind, l.text, l.newLine])).toEqual([
      ["added", "line 1", 1],
      ["added", "line 2", 2],
    ]);

    const removed = computeLineDiff("line 1\nline 2", "");
    expect(removed.added).toBe(0);
    expect(removed.removed).toBe(2);
    expect(removed.lines.map((l) => [l.kind, l.text, l.oldLine])).toEqual([
      ["removed", "line 1", 1],
      ["removed", "line 2", 2],
    ]);
  });

  it("handles CRLF line endings cleanly", () => {
    const diff = computeLineDiff("a\r\nb\r\nc", "a\r\nB\r\nc");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "context:a",
      "removed:b",
      "added:B",
      "context:c",
    ]);
  });
});

describe("#148 formatting helpers", () => {
  it("formats byte sizes cleanly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("formats timestamps for zh-TW and en locales", () => {
    const ts = Date.UTC(2026, 10, 28, 4, 30, 15);
    const zh = formatHistoryTimestamp(ts, "zh-TW");
    const en = formatHistoryTimestamp(ts, "en");
    expect(zh).toMatch(/2026/);
    expect(en).toMatch(/2026/);
  });
});
