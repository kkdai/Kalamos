/**
 * Vitest global setup (jsdom).
 *
 * jsdom has no layout engine, so `Range.prototype.getClientRects` /
 * `getBoundingClientRect` are missing. CodeMirror's measure pass (scheduled in
 * requestAnimationFrame) calls them on text ranges; when that rAF fires the
 * test run reports an unhandled `getClientRects is not a function` error and
 * vitest exits 1 even though every test passed (issue #32 / BUG-8).
 *
 * We stub them with empty geometry, and destroy any editor view a test left
 * mounted so no measure callback outlives its test.
 */
import { EditorView } from "@codemirror/view";
import { afterEach } from "vitest";

function emptyRect(): DOMRect {
  if (typeof DOMRect === "function") {
    return new DOMRect(0, 0, 0, 0);
  }
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function emptyRectList(): DOMRectList {
  const list: DOMRect[] & { item?: (index: number) => DOMRect | null } = [];
  list.item = () => null;
  return list as unknown as DOMRectList;
}

if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
}

afterEach(() => {
  if (typeof document === "undefined") return;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cm-editor"))) {
    EditorView.findFromDOM(el)?.destroy();
  }
});
