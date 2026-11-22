import { describe, expect, it } from "vitest";
import {
  activeIndexAfterClose,
  isMarkdownPath,
  resolveOpenTarget,
  unsavedChangesMessage,
  cycleIndex,
  moveItem,
  nextUntitledNumber,
  tabLabels,
  untitledLabel,
} from "./tab-model";

describe("#81 tab naming", () => {
  it("untitled tabs are 未命名, 未命名 2, 未命名 3…", () => {
    expect(untitledLabel(1)).toBe("未命名");
    expect(untitledLabel(2)).toBe("未命名 2");
    expect(untitledLabel(3)).toBe("未命名 3");
  });

  it("picks the lowest free untitled number", () => {
    expect(nextUntitledNumber([])).toBe(1);
    expect(nextUntitledNumber([1, 2])).toBe(3);
    expect(nextUntitledNumber([2, 3])).toBe(1);
    expect(nextUntitledNumber([1, 3])).toBe(2);
  });

  it("saved tabs show the file name", () => {
    const labels = tabLabels([
      { id: "a", path: "/notes/a.md", untitledNumber: 0 },
      { id: "b", path: null, untitledNumber: 2 },
    ]);
    expect(labels.get("a")).toBe("a.md");
    expect(labels.get("b")).toBe("未命名 2");
  });

  it("same-name files show their parent folder", () => {
    const labels = tabLabels([
      { id: "a", path: "/proj/docs/README.md", untitledNumber: 0 },
      { id: "b", path: "/proj/README.md", untitledNumber: 0 },
      { id: "c", path: "/proj/docs/guide.md", untitledNumber: 0 },
    ]);
    expect(labels.get("a")).toBe("README.md — docs");
    expect(labels.get("b")).toBe("README.md — proj");
    expect(labels.get("c")).toBe("guide.md");
  });

  it("adds more folders when the parent names also collide", () => {
    const labels = tabLabels([
      { id: "a", path: "/x/docs/README.md", untitledNumber: 0 },
      { id: "b", path: "/y/docs/README.md", untitledNumber: 0 },
    ]);
    expect(labels.get("a")).toBe("README.md — x/docs");
    expect(labels.get("b")).toBe("README.md — y/docs");
  });

  it("handles Windows separators", () => {
    const labels = tabLabels([
      { id: "a", path: "C:\\a\\note.md", untitledNumber: 0 },
      { id: "b", path: "C:\\b\\note.md", untitledNumber: 0 },
    ]);
    expect(labels.get("a")).toBe("note.md — a");
    expect(labels.get("b")).toBe("note.md — b");
  });
});

describe("#81 tab navigation", () => {
  it("cycles with wrap-around", () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 1, 1)).toBe(0);
  });

  it("closing the active tab activates its right neighbour, or the left one at the end", () => {
    expect(activeIndexAfterClose(1, 1, 3)).toBe(1);
    expect(activeIndexAfterClose(2, 2, 3)).toBe(1);
    expect(activeIndexAfterClose(0, 0, 1)).toBe(-1);
  });

  it("closing another tab keeps the active one", () => {
    expect(activeIndexAfterClose(0, 2, 3)).toBe(1);
    expect(activeIndexAfterClose(2, 0, 3)).toBe(0);
  });

  it("moves an item", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("#81 B open rules", () => {
  const tabs = [
    { id: "a", path: "/n/a.md", dirty: false, pristine: false },
    { id: "u", path: null, dirty: false, pristine: true },
    { id: "d", path: null, dirty: true, pristine: false },
  ];

  it("an already open file is switched to, whatever the mode", () => {
    for (const mode of ["tab", "current", "newTab"] as const) {
      expect(resolveOpenTarget(tabs, "u", "/n/a.md", mode)).toEqual({ kind: "existing", id: "a" });
    }
  });

  it("a blank untitled tab is reused (not for Cmd+click)", () => {
    expect(resolveOpenTarget(tabs, "u", "/n/b.md", "tab")).toEqual({ kind: "replace" });
    expect(resolveOpenTarget(tabs, "u", "/n/b.md", "current")).toEqual({ kind: "replace" });
    expect(resolveOpenTarget(tabs, "u", "/n/b.md", "newTab")).toEqual({ kind: "new" });
  });

  it("Cmd+O / Finder / drop / search open a new tab", () => {
    expect(resolveOpenTarget(tabs, "a", "/n/b.md", "tab")).toEqual({ kind: "new" });
  });

  it("a sidebar click uses the current tab unless it has unsaved changes", () => {
    expect(resolveOpenTarget(tabs, "a", "/n/b.md", "current")).toEqual({ kind: "replace" });
    expect(resolveOpenTarget(tabs, "d", "/n/b.md", "current")).toEqual({ kind: "new" });
  });

  it("recognises Markdown files", () => {
    expect(isMarkdownPath("/x/Notes.MD")).toBe(true);
    expect(isMarkdownPath("/x/a.markdown")).toBe(true);
    expect(isMarkdownPath("/x/a.png")).toBe(false);
    expect(isMarkdownPath("/x/.md")).toBe(false);
  });

  it("lists the unsaved documents", () => {
    expect(unsavedChangesMessage(["a.md", "未命名 2"])).toBe(
      "以下 2 份文件有未儲存的變更：\n・a.md\n・未命名 2\n\n要在關閉前儲存嗎？",
    );
  });
});
