import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getMockAllowedAssetDirs,
  getMockAssetFiles,
  resetMockState,
  seedMockFile,
  triggerMockFileDrop,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  buildImageInsertion,
  collectImageSpecs,
  imageExtFromMime,
  isImageFilePath,
  resolveImageSrc,
} from "./images";

const toUrl = (p: string) => `asset://localhost/${encodeURIComponent(p)}`;

function setupDom(): void {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message"></span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn">還原</button>
          <button type="button" id="recovery-discard-btn">捨棄</button>
        </div>
      </div>
      <main id="editor-container" aria-label="Markdown Editor"></main>
      <div id="status" data-testid="status" role="status" aria-live="polite"></div>
    </div>
  `;
}

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

// jsdom has no layout: give Range the rect APIs CodeMirror's measure pass calls
// when an animation frame fires during async tests.
beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto.getClientRects !== "function") {
    proto.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resolveImageSrc (IM-01 path resolution)", () => {
  const doc = "/tmp/kalamos-test/notes/post.md";

  it("resolves relative paths against the document folder", () => {
    expect(resolveImageSrc("assets/cat.png", doc, toUrl)).toEqual({
      kind: "local",
      path: "/tmp/kalamos-test/notes/assets/cat.png",
      url: toUrl("/tmp/kalamos-test/notes/assets/cat.png"),
    });
    expect(resolveImageSrc("./a/./b.png", doc, toUrl)).toMatchObject({
      path: "/tmp/kalamos-test/notes/a/b.png",
    });
  });

  it("handles ../ segments", () => {
    expect(resolveImageSrc("../shared/x.jpg", doc, toUrl)).toMatchObject({
      kind: "local",
      path: "/tmp/kalamos-test/shared/x.jpg",
    });
    expect(resolveImageSrc("../../../../../x.jpg", doc, toUrl)).toMatchObject({
      path: "/x.jpg",
    });
  });

  it("decodes %20 and <...> destinations", () => {
    expect(resolveImageSrc("assets/my%20cat.png", doc, toUrl)).toMatchObject({
      path: "/tmp/kalamos-test/notes/assets/my cat.png",
    });
    expect(resolveImageSrc("<assets/my cat.png>", doc, toUrl)).toMatchObject({
      path: "/tmp/kalamos-test/notes/assets/my cat.png",
    });
    // Malformed escapes do not throw.
    expect(resolveImageSrc("bad%E0%20name.png", doc, toUrl)).toMatchObject({
      path: "/tmp/kalamos-test/notes/bad%E0 name.png",
    });
  });

  it("keeps absolute paths and file:// URLs as local files", () => {
    expect(resolveImageSrc("/tmp/pic.png", doc, toUrl)).toMatchObject({
      kind: "local",
      path: "/tmp/pic.png",
    });
    expect(resolveImageSrc("/tmp/pic.png", null, toUrl)).toMatchObject({
      kind: "local",
      path: "/tmp/pic.png",
    });
    expect(
      resolveImageSrc("file:///tmp/my%20pic.png", doc, toUrl),
    ).toMatchObject({
      kind: "local",
      path: "/tmp/my pic.png",
    });
  });

  it("loads http(s) URLs directly", () => {
    expect(resolveImageSrc("https://example.com/a.png", doc, toUrl)).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
    });
    expect(resolveImageSrc("http://example.com/a.png", null, toUrl)).toEqual({
      kind: "remote",
      url: "http://example.com/a.png",
    });
  });

  it("only accepts image/* data URLs and rejects other schemes", () => {
    expect(
      resolveImageSrc("data:image/png;base64,iVBORw0KGgo=", doc, toUrl),
    ).toMatchObject({ kind: "data" });
    expect(
      resolveImageSrc("data:image/svg+xml,<svg/>", doc, toUrl),
    ).toMatchObject({
      kind: "data",
    });
    expect(resolveImageSrc("data:text/html,<b>x</b>", doc, toUrl).kind).toBe(
      "invalid",
    );
    expect(resolveImageSrc("javascript:alert(1)", doc, toUrl).kind).toBe(
      "invalid",
    );
  });

  it("asks to save first for relative paths in untitled documents", () => {
    expect(resolveImageSrc("assets/cat.png", null, toUrl)).toEqual({
      kind: "needs-save",
    });
  });
});

describe("collectImageSpecs", () => {
  it("extracts alt, src and title", () => {
    const state = stateOf(
      'text ![a cat](assets/cat.png "Title") and ![](<my pic.png>)\n',
    );
    const specs = collectImageSpecs(state);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      alt: "a cat",
      src: "assets/cat.png",
      title: "Title",
    });
    expect(state.sliceDoc(specs[0].from, specs[0].to)).toBe(
      '![a cat](assets/cat.png "Title")',
    );
    expect(specs[1].alt).toBe("");
    expect(resolveImageSrc(specs[1].src, "/d/x.md", toUrl)).toMatchObject({
      path: "/d/my pic.png",
    });
  });
});

describe("image helpers", () => {
  it("detects image files and clipboard mime types", () => {
    expect(isImageFilePath("/a/b/Photo.JPG")).toBe(true);
    expect(isImageFilePath("/a/b/x.svg")).toBe(true);
    expect(isImageFilePath("/a/b/notes.md")).toBe(false);
    expect(isImageFilePath("/a/b/.png")).toBe(false);
    expect(imageExtFromMime("image/jpeg")).toBe("jpg");
    expect(imageExtFromMime("image/svg+xml")).toBe("svg");
    expect(imageExtFromMime("text/plain")).toBeNull();
  });

  it("builds one ![](...) line per image, splitting the current line when needed", () => {
    const empty = stateOf("");
    expect(buildImageInsertion(empty, 0, ["assets/a.png"])).toEqual({
      from: 0,
      insert: "![](assets/a.png)",
      cursor: 17,
    });

    const mid = stateOf("hello world");
    const ins = buildImageInsertion(mid, 5, ["assets/a.png", "assets/b.png"])!;
    const next = mid
      .update({ changes: { from: ins.from, insert: ins.insert } })
      .state.doc.toString();
    expect(next).toBe("hello\n![](assets/a.png)\n![](assets/b.png)\n world");

    const end = stateOf("line\n");
    const atEnd = buildImageInsertion(end, 4, ["x.png"])!;
    expect(atEnd.insert).toBe("\n![](x.png)");

    expect(buildImageInsertion(empty, 0, [])).toBeNull();
  });
});

describe("Images in the editor (IM-01 / IM-02)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.restoreAllMocks();
  });

  it("renders an image widget when the cursor is elsewhere and reveals source when clicked", async () => {
    seedMockFile(
      "/tmp/kalamos/img/post.md",
      '第一段\n\n![小貓](assets/my%20cat.png "貓")\n',
    );
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/kalamos/img/post.md");
    const { view } = app.editor;
    app.editor.setCursor(0);

    const widget = view.dom.querySelector<HTMLElement>(
      '[data-testid="image-widget"]',
    );
    expect(widget).not.toBeNull();
    const img = widget!.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent("/tmp/kalamos/img/assets/my cat.png")}`,
    );
    expect(img.alt).toBe("小貓");
    expect(widget!.title).toBe("貓");
    // Decoration only: document text is unchanged.
    expect(app.editor.getContent()).toContain(
      '![小貓](assets/my%20cat.png "貓")',
    );
    // Document folder was added to the asset scope.
    expect(getMockAllowedAssetDirs()).toContain("/tmp/kalamos/img");

    widget!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    const imageStart = app.editor.getContent().indexOf("![");
    expect(view.state.selection.main.head).toBe(imageStart + 2);
    expect(view.dom.querySelector('[data-testid="image-widget"]')).toBeNull();
  });

  it("shows alt text and a broken-image hint when loading fails", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("![遠端圖](https://example.com/missing.png)\n\n文字");
    app.editor.setCursor(app.editor.getContent().length);

    const widget = app.editor.view.dom.querySelector<HTMLElement>(
      '[data-testid="image-widget"]',
    )!;
    const img = widget.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/missing.png");
    img.dispatchEvent(new Event("error"));

    expect(widget.dataset.state).toBe("error");
    expect(widget.querySelector("img")).toBeNull();
    const fallback = widget.querySelector('[data-testid="image-fallback"]')!;
    expect(fallback.textContent).toContain("遠端圖");
    expect(fallback.querySelector("svg")).not.toBeNull();
  });

  it("shows a save-first hint for relative images in untitled documents, then the image after saving", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("![圖](assets/a.png)\n\n尾");
    app.editor.setCursor(app.editor.getContent().length);

    const hint = app.editor.view.dom.querySelector(
      '[data-testid="image-needs-save"]',
    );
    expect(hint?.textContent).toContain("存檔後才能顯示相對路徑圖片");

    await app.saveDocumentAs("/tmp/kalamos/saved/doc.md");
    expect(
      app.editor.view.dom.querySelector('[data-testid="image-needs-save"]'),
    ).toBeNull();
    const img = app.editor.view.dom.querySelector(
      '[data-testid="image-widget"] img',
    );
    expect(img?.getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent("/tmp/kalamos/saved/assets/a.png")}`,
    );
  });

  it("hides the widget while the cursor is inside the image source and in source mode", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("![x](https://example.com/x.png)\n\nmore");
    app.editor.setCursor(3);
    expect(
      app.editor.view.dom.querySelector('[data-testid="image-widget"]'),
    ).toBeNull();
    app.editor.setCursor(app.editor.getContent().length);
    expect(
      app.editor.view.dom.querySelector('[data-testid="image-widget"]'),
    ).not.toBeNull();
    app.editor.setSourceMode(true);
    expect(
      app.editor.view.dom.querySelector('[data-testid="image-widget"]'),
    ).toBeNull();
  });

  it("dropping image files inserts ![](assets/...) lines in order, with collision suffixes", async () => {
    seedMockFile("/tmp/kalamos/drop/post.md", "開頭\n");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/kalamos/drop/post.md");
    app.editor.setCursor(app.editor.getContent().length);

    await triggerMockFileDrop({
      paths: [
        "/tmp/kalamos-test/Desktop/my cat.png",
        "/tmp/kalamos-test/notes.txt",
        "/tmp/kalamos-test/b.JPG",
      ],
    });
    await flush();

    expect(app.editor.getContent()).toBe(
      "開頭\n![](assets/my%20cat.png)\n![](assets/b.jpg)",
    );
    expect(getMockAssetFiles()).toEqual([
      "/tmp/kalamos/drop/assets/my cat.png",
      "/tmp/kalamos/drop/assets/b.jpg",
    ]);

    await app.dropImageFiles(["/elsewhere/my cat.png"]);
    expect(app.editor.getContent()).toContain("![](assets/my%20cat-1.png)");
  });

  it("dropping images into an untitled document asks to save first and inserts nothing", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("草稿");
    await triggerMockFileDrop({
      paths: ["/tmp/kalamos-test/a.png"],
    });
    await flush();
    expect(app.editor.getContent()).toBe("草稿");
    expect(app.getStatusText()).toBe("請先儲存文件，才能插入圖片");
    expect(getMockAssetFiles()).toEqual([]);
  });

  it("pasting a clipboard image stores it as pasted-<timestamp> and inserts it at the cursor", async () => {
    seedMockFile("/tmp/kalamos/paste/post.md", "a\n");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/kalamos/paste/post.md");
    app.editor.setCursor(2);

    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      "image.png",
      {
        type: "image/png",
      },
    );
    const event = new Event("paste", {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        files: [file],
        getData: () => "",
      },
    });
    app.editor.view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(app!.editor.getContent()).toMatch(
        /^a\n!\[\]\(assets\/pasted-\d{8}-\d{6}\.png\)$/,
      );
    });
  });

  it("pasting an image into an untitled document asks to save first", async () => {
    app = createKalamosApp(document);
    await app.init();
    const file = new File([new Uint8Array([1])], "x.png", {
      type: "image/png",
    });
    const ok = await app.insertPastedImages([file], 0);
    expect(ok).toBe(false);
    expect(app.editor.getContent()).toBe("");
    expect(app.getStatusText()).toBe("請先儲存文件，才能插入圖片");
  });
});
