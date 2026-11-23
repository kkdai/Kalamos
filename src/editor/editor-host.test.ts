import { undo, undoDepth } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../ipc";
import { openBrowserExternalLink } from "./browser-editor-host";
import {
  type CreateEditorOptions,
  createEditor,
  type KalamosEditor,
} from "./index";
import { navigateMarkdownLink } from "./live-preview";

let editor: KalamosEditor | undefined;

function mount(
  options: Pick<
    CreateEditorOptions,
    "initialContent" | "host" | "onOpenRelativeLink"
  >,
): KalamosEditor {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const noop = () => {};
  editor = createEditor({
    ...options,
    parent,
    handlers: {
      onOpenFile: noop,
      onNewFile: noop,
      onSaveFile: noop,
      onSaveFileAs: noop,
    },
  });
  return editor;
}

function assetUrl(path: string): string {
  return `/api/assets?${new URLSearchParams({ path })}`;
}

function images(editor: KalamosEditor) {
  return Array.from(
    editor.view.contentDOM.querySelectorAll<HTMLImageElement>(
      "img.k-image-img",
    ),
  );
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("EditorHost", () => {
  it("resolves local Markdown and HTML images under the virtual document and front matter root", () => {
    const allowDir = vi.spyOn(ipc, "allowAssetDir");
    const allowFile = vi.spyOn(ipc, "allowAssetFile");
    const localFileUrl = vi.spyOn(ipc, "localFileUrl");
    const resolveLocalImage = vi.fn(assetUrl);
    const editor = mount({
      initialContent: [
        "---",
        "typora-root-url: ../static",
        "---",
        "",
        "![relative](assets/my%20image.png)",
        "",
        "![parent](../other/pic.png)",
        "",
        '<img src="/assets/pic.png" width="120">',
        "",
        "![web](https://example.com/preview.png)",
        "",
        "![inline](data:image/png;base64,iVBORw0KGgo=)",
      ].join("\n"),
      host: { resolveLocalImage, openExternalLink: vi.fn() },
    });
    editor.setImageRootDir("/setting");
    resolveLocalImage.mockClear();
    editor.setDocumentPath("/dir/doc.md");
    expect(resolveLocalImage.mock.calls.flat()).toEqual([
      "/dir/assets/my image.png",
      "/other/pic.png",
      "/static/assets/pic.png",
    ]);
    expect(images(editor).map((img) => img.getAttribute("src"))).toEqual([
      assetUrl("/dir/assets/my image.png"),
      assetUrl("/other/pic.png"),
      assetUrl("/static/assets/pic.png"),
      "https://example.com/preview.png",
      "data:image/png;base64,iVBORw0KGgo=",
    ]);
    expect(images(editor)[2].style.width).toBe("120px");
    expect(allowDir).not.toHaveBeenCalled();
    expect(allowFile).not.toHaveBeenCalled();
    expect(localFileUrl).not.toHaveBeenCalled();
  });

  it("shows the missing path and retries on refresh without altering history or selection", () => {
    const allowFile = vi.spyOn(ipc, "allowAssetFile");
    const assets = new Set<string>();
    const initialContent = "![pic](assets/pic.png)\n\nend";
    const editor = mount({
      initialContent,
      host: {
        resolveLocalImage: (path) => (assets.has(path) ? assetUrl(path) : null),
        openExternalLink: vi.fn(),
      },
    });
    const fallback = () => editor.view.dom.querySelector(".k-image-fallback");
    editor.setDocumentPath("/dir/doc.md");
    editor.view.dispatch({
      changes: { from: initialContent.length, insert: "!" },
      selection: { anchor: initialContent.length + 1 },
      userEvent: "input.type",
    });
    expect(images(editor)).toHaveLength(0);
    expect(fallback()?.textContent).toContain("/dir/assets/pic.png");

    const sameDocument = editor.getSession();
    assets.add("/dir/assets/pic.png");
    editor.refreshImages();
    expect(fallback()).toBeNull();
    const [first] = images(editor);
    expect(first.getAttribute("src")).toBe(assetUrl("/dir/assets/pic.png"));
    first.dispatchEvent(new Event("error"));
    expect(fallback()?.textContent).toContain("/dir/assets/pic.png");
    expect(allowFile).not.toHaveBeenCalled();
    editor.refreshImages();
    const [retried] = images(editor);
    expect(retried).not.toBe(first);
    expect(retried.getAttribute("src")).toBe(first.getAttribute("src"));

    // A path change, such as a rename into another folder, also resolves again.
    editor.setDocumentPath("/moved/doc.md");
    expect(fallback()?.textContent).toContain("/moved/assets/pic.png");
    expect(editor.getSession()).toBe(sameDocument);
    expect(editor.view.state.selection.main.head).toBe(
      initialContent.length + 1,
    );
    expect(editor.getContent()).toBe(`${initialContent}!`);
    expect(undoDepth(editor.view.state)).toBe(1);
    expect(undo(editor.view)).toBe(true);
    expect(editor.getContent()).toBe(initialContent);
  });

  it("sends only allowed external links to the host and keeps workspace links separate", () => {
    const openExternalLink = vi.fn();
    const onOpenRelativeLink = vi.fn();
    const editor = mount({
      initialContent: "# Intro\n\nend",
      host: { resolveLocalImage: () => null, openExternalLink },
      onOpenRelativeLink,
    });
    const open = (url: string) => navigateMarkdownLink(url, editor.view);
    expect(open(" https://example.com ")).toBe(true);
    expect(open("mailto:help@example.com")).toBe(true);
    expect(open("javascript:alert(1)")).toBe(false);
    expect(open("file:///notes/doc.md")).toBe(false);
    expect(open("../notes/doc.md#intro")).toBe(true);
    expect(onOpenRelativeLink).toHaveBeenCalledWith(
      "../notes/doc.md",
      "intro",
      editor.view,
    );
    expect(open("#intro")).toBe(true);
    expect(openExternalLink.mock.calls.flat()).toEqual([
      "https://example.com",
      "mailto:help@example.com",
    ]);
  });

  it("opens browser links in a new tab without an opener or referrer", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openBrowserExternalLink("https://example.com");
    expect(open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
