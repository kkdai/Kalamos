import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExportHtml } from "../export/html";
import { prepareMarkdownForPandoc } from "../export/pandoc";
import * as ipc from "../ipc";
import {
  ensureAssetFileAllowed,
  imageDocPathField,
  imagePreviewPlugin,
  imageRootSettingField,
  needsAssetFileAllow,
  resetAssetFileAllowCache,
  setImageDocPathEffect,
} from "./images";

/** #69: `../images/pic.png` from `_posts/` lies outside the document folder. */

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, allowAssetFile: vi.fn(actual.allowAssetFile) };
});

const allowAssetFile = vi.mocked(ipc.allowAssetFile);

const DOC = "/tmp/kalamos-test/blog/_posts/2026-11-15-post.md";
const PIC = "/tmp/kalamos-test/blog/images/pic.png";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function mount(doc: string, docPath: string | null = DOC): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ base: markdownLanguage }),
        imageDocPathField,
        imageRootSettingField,
        imagePreviewPlugin,
      ],
    }),
    parent,
  });
  view.dispatch({ effects: setImageDocPathEffect.of(docPath) });
  return view;
}

const imgs = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll<HTMLImageElement>("img.k-image-img"));

beforeEach(() => {
  ipc.resetMockState();
  resetAssetFileAllowCache();
  allowAssetFile.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("#69 needsAssetFileAllow", () => {
  it("only paths outside the document folder and image root need a file allow", () => {
    expect(needsAssetFileAllow(PIC, DOC, null)).toBe(true);
    expect(needsAssetFileAllow("/tmp/kalamos-test/blog/_posts/a.png", DOC, null)).toBe(false);
    expect(needsAssetFileAllow("/tmp/kalamos-test/blog/_posts/sub/a.png", DOC, null)).toBe(false);
    // A sibling folder sharing a name prefix is still outside.
    expect(needsAssetFileAllow("/tmp/kalamos-test/blog/_posts2/a.png", DOC, null)).toBe(true);
    expect(needsAssetFileAllow(PIC, DOC, "/tmp/kalamos-test/blog")).toBe(false);
    expect(needsAssetFileAllow(PIC, null, null)).toBe(true);
  });
});

describe("#69 allow a single parent-folder image", () => {
  it("a ../ image asks for that one file, then loads it", async () => {
    const view = mount("![pic](../images/pic.png)\n\nend");
    const widget = view.contentDOM.querySelector<HTMLElement>("[data-testid=image-widget]")!;
    expect(widget.dataset.path).toBe(PIC);
    // Not loaded before the scope allows it (no permanent broken image).
    expect(imgs(view)).toHaveLength(0);
    await flush();
    expect(allowAssetFile).toHaveBeenCalledTimes(1);
    expect(allowAssetFile).toHaveBeenCalledWith(PIC);
    expect(ipc.getMockAllowedAssetFiles()).toEqual([PIC]);
    expect(ipc.getMockAllowedAssetDirs()).not.toContain("/tmp/kalamos-test/blog/images");
    const [img] = imgs(view);
    expect(decodeURIComponent(img.src)).toContain(PIC);
    expect(widget.dataset.assetScope).toBe("file");
    view.destroy();
  });

  it("<img src=../…> with zoom uses the same allow and keeps its size", async () => {
    const view = mount(`<img src="../images/pic.png" width="120">\n\nend`);
    await flush();
    expect(allowAssetFile).toHaveBeenCalledWith(PIC);
    const [img] = imgs(view);
    expect(img.style.width).toBe("120px");
    view.destroy();
  });

  it("caches allowed files: re-rendering and concurrent requests call the backend once", async () => {
    const view = mount("![a](../images/pic.png)\n\n![b](../images/pic.png)\n\nend");
    await flush();
    expect(allowAssetFile).toHaveBeenCalledTimes(1);
    expect(imgs(view)).toHaveLength(2);
    // Moving the cursor re-renders the widgets: no new backend call.
    view.dispatch({ selection: { anchor: 3 } });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await flush();
    expect(allowAssetFile).toHaveBeenCalledTimes(1);
    expect(await ensureAssetFileAllowed(PIC)).toBe(true);
    expect(allowAssetFile).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("images inside the document folder do not ask for a file allow", async () => {
    const view = mount("![a](assets/a.png)\n\nend");
    await flush();
    expect(allowAssetFile).not.toHaveBeenCalled();
    expect(imgs(view)).toHaveLength(1);
    view.destroy();
  });

  it("a refused file (not an image) falls back to the broken-image box", async () => {
    const view = mount("![x](../secret.txt)\n\nend");
    await flush();
    expect(allowAssetFile).toHaveBeenCalledWith("/tmp/kalamos-test/blog/secret.txt");
    expect(ipc.getMockAllowedAssetFiles()).toEqual([]);
    const [img] = imgs(view);
    img.dispatchEvent(new Event("error"));
    await flush();
    expect(view.contentDOM.querySelector("[data-testid=image-fallback]")).not.toBeNull();
    view.destroy();
  });

  it("a load error on a not-yet-allowed file allows it and re-renders the image once", async () => {
    // A path in the document folder is assumed to be in scope; if it still
    // fails to load, the file is allowed individually and loaded again.
    const view = mount("![a](pic.png)\n\nend", "/tmp/kalamos-test/blog/images/doc.md");
    await flush();
    expect(allowAssetFile).not.toHaveBeenCalled();
    const [first] = imgs(view);
    first.dispatchEvent(new Event("error"));
    await flush();
    expect(allowAssetFile).toHaveBeenCalledWith(PIC);
    const [second] = imgs(view);
    expect(second).not.toBe(first);
    expect(decodeURIComponent(second.src)).toContain(PIC);
    // A second failure after the allow shows the fallback instead of looping.
    second.dispatchEvent(new Event("error"));
    await flush();
    expect(allowAssetFile).toHaveBeenCalledTimes(1);
    expect(view.contentDOM.querySelector("[data-testid=image-fallback]")).not.toBeNull();
    view.destroy();
  });
});

describe("#69 parent-folder images in export", () => {
  it("HTML / PDF export resolves ../ to the absolute file URL", async () => {
    const md = `![pic](../images/pic.png)\n\n<img src="../images/pic.png" style="zoom:50%">`;
    const { html } = await buildExportHtml(md, { title: "t", docPath: DOC });
    expect(html).toContain(`<img src="file://${PIC}" alt="pic">`);
    expect(html).toContain(`<img src="file://${PIC}" alt="" style="zoom:0.5">`);
  });

  it("Pandoc export rewrites ../ to an absolute path", () => {
    const md = `![pic](../images/pic.png)\n\n<img src="../images/pic.png" width="120">`;
    const { markdown: out } = prepareMarkdownForPandoc(md, DOC, null);
    expect(out).toContain(`![pic](${PIC})`);
    expect(out).toContain(`](${PIC}){width=120px}`);
  });
});
