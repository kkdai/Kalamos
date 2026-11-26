import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExportHtml } from "../export/html";
import {
  allowAssetDir,
  getMockAllowedAssetDirs,
  getSettings,
  isAssetDirTooBroadError,
  MOCK_HOME_DIR,
  resetMockState,
  setMockDialogHandlers,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  findTyporaRootUrlInText,
  imageSizeCss,
  parseImageStyle,
  parseImgAttributes,
  parseImgTag,
} from "./image-attrs";
import {
  applyImageSize,
  collectImageSpecs,
  effectiveImageRoot,
  imageDocPathField,
  imagePreviewPlugin,
  imageRootSettingField,
  resolveImageRoot,
  resolveImageSrc,
  setImageDocPathEffect,
  setImageRootSettingEffect,
} from "./images";
import { ensureFullSyntaxTree } from "./test-utils";

const toUrl = (p: string) => `asset://localhost/${encodeURIComponent(p)}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stateOf(doc: string): EditorState {
  return ensureFullSyntaxTree(
    EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        imageDocPathField,
        imageRootSettingField,
      ],
    }),
  );
}

describe("IM-03 <img> attribute parser", () => {
  it("reads double-, single- and unquoted values; names are case-insensitive", () => {
    const attrs = parseImgAttributes(
      `<IMG SRC="a b.png" alt='貓' title=hi width=120 />`,
    );
    expect(attrs && Object.fromEntries(attrs)).toEqual({
      src: "a b.png",
      alt: "貓",
      title: "hi",
      width: "120",
    });
    expect(parseImgAttributes("<img src=a.png/>")?.get("src")).toBe("a.png");
    expect(parseImgAttributes("<img src=a.png>")?.get("src")).toBe("a.png");
  });

  it("decodes entities, keeps the first duplicate", () => {
    const attrs = parseImgAttributes(
      `<img src="a&amp;b.png" alt="&quot;x&quot;" src="other.png">`,
    );
    expect(attrs?.get("src")).toBe("a&b.png");
    expect(attrs?.get("alt")).toBe('"x"');
  });

  it("rejects anything that is not exactly one img tag", () => {
    for (const raw of [
      "<imgx src=a>",
      "<img src=a",
      '<img src="a>',
      "<img src=a> trailing",
      "<p><img src=a></p>",
      '<img src="a"alt="b">',
      "<image src=a>",
    ]) {
      expect(parseImgAttributes(raw), raw).toBeNull();
    }
  });

  it("ignores unknown attributes such as onerror / srcset", () => {
    const tag = parseImgTag(
      `<img src="a.png" onerror="alert(1)" srcset="b.png 2x" class="x">`,
    );
    expect(tag).toEqual({ src: "a.png", alt: "", title: null, size: {} });
  });

  it("javascript: and other unsupported schemes are rejected by resolveImageSrc", () => {
    const tag = parseImgTag(`<img src="javascript:alert(1)">`)!;
    expect(resolveImageSrc(tag.src, "/n/d.md", toUrl).kind).toBe("invalid");
    const tag2 = parseImgTag(`<img src="  JaVaScRiPt:alert(1)">`)!;
    expect(resolveImageSrc(tag2.src, "/n/d.md", toUrl).kind).toBe("invalid");
    expect(parseImgTag(`<img alt="no src">`)).toBeNull();
  });

  it("zoom / width / height → sizes; only allow-listed style properties", () => {
    expect(parseImgTag(`<img src="a.png" style="zoom:50%">`)?.size).toEqual({
      zoom: 0.5,
    });
    expect(parseImgTag(`<img src="a.png" style="zoom: 0.25;">`)?.size).toEqual({
      zoom: 0.25,
    });
    expect(
      parseImgTag(`<img src="a.png" width="300" height="50%">`)?.size,
    ).toEqual({
      width: "300px",
      height: "50%",
    });
    // style overrides attributes; junk values / properties are dropped.
    expect(
      parseImgTag(
        `<img src="a.png" width="10" style="width: 20em; max-width:100%; position:fixed; background:url(x); height: expression(alert(1)); zoom: 9999%">`,
      )?.size,
    ).toEqual({ width: "20em", maxWidth: "100%" });
    expect(parseImageStyle("width: 12; height: -3px; zoom: 0")).toEqual({});
    expect(
      parseImgTag(`<img src="a.png" width="abc" height="1e9">`)?.size,
    ).toEqual({});
  });

  it("imageSizeCss only emits normalised values", () => {
    expect(imageSizeCss({ maxWidth: "100%", zoom: 0.5 })).toBe(
      "max-width:100%;zoom:0.5",
    );
    expect(imageSizeCss({ width: "200px", zoom: 0.5 })).toBe("width:100px");
    expect(imageSizeCss(undefined)).toBe("");
  });
});

describe("IM-03 sizes in the widget", () => {
  function fakeImg(natural: number): HTMLImageElement {
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", {
      value: natural,
      configurable: true,
    });
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    return img;
  }

  it("zoom without explicit size scales the natural width", () => {
    const img = fakeImg(400);
    applyImageSize(img, { zoom: 0.5 });
    expect(img.style.width).toBe("200px");
  });

  it("zoom waits for load when the image is not decoded yet", () => {
    const img = document.createElement("img");
    applyImageSize(img, { zoom: 0.5 });
    expect(img.style.width).toBe("");
    Object.defineProperty(img, "naturalWidth", {
      value: 300,
      configurable: true,
    });
    img.dispatchEvent(new Event("load"));
    expect(img.style.width).toBe("150px");
  });

  it("explicit width / height are CSS sizes; zoom then scales them", () => {
    const img = fakeImg(400);
    applyImageSize(img, { width: "120px", height: "50%" });
    expect(img.style.width).toBe("120px");
    expect(img.style.height).toBe("50%");
    const zoomed = fakeImg(400);
    applyImageSize(zoomed, { width: "120px", height: "50%", zoom: 0.5 });
    expect(zoomed.style.width).toBe("60px");
    expect(zoomed.style.height).toBe("25%");
  });

  it("collectImageSpecs finds inline <img> tags and whole-line <img> blocks", () => {
    const doc = [
      `文字 <img src="a.png" style="zoom:50%"> 後面`,
      "",
      `<img src="b.png" width="80" alt="B">`,
      "",
      "<div>not an image</div>",
      "",
      "![md](c.png)",
    ].join("\n");
    const specs = collectImageSpecs(stateOf(doc));
    expect(specs.map((s) => [s.src, s.html ?? false, s.size ?? null])).toEqual([
      ["a.png", true, { zoom: 0.5 }],
      ["b.png", true, { width: "80px" }],
      ["c.png", false, null],
    ]);
    const first = specs[0];
    expect(doc.slice(first.from, first.to)).toBe(
      `<img src="a.png" style="zoom:50%">`,
    );
    expect(specs[1].alt).toBe("B");
  });

  it("renders <img> as an image widget outside the cursor, source inside", async () => {
    const doc = `<img src="/pics/a.png" style="zoom:50%">\n\nend`;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: ensureFullSyntaxTree(
        EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            markdown({ base: markdownLanguage }),
            imageDocPathField,
            imageRootSettingField,
            imagePreviewPlugin,
          ],
        }),
      ),
      parent,
    });
    // #69: outside the (untitled) document folder, the file is allowed before it loads.
    await vi.waitFor(() =>
      expect(view.contentDOM.querySelector("img.k-image-img")).not.toBeNull(),
    );
    const img =
      view.contentDOM.querySelector<HTMLImageElement>("img.k-image-img");
    expect(decodeURIComponent(img!.src)).toContain("/pics/a.png");
    expect(img!.classList.contains("k-image-sized")).toBe(true);
    view.dispatch({ selection: { anchor: 5 } });
    expect(view.contentDOM.querySelector("img.k-image-img")).toBeNull();
    expect(view.contentDOM.textContent).toContain(`<img src="/pics/a.png"`);
    view.destroy();
  });
});

describe("IM-04 image root resolution", () => {
  it("without a root, behaviour is unchanged", () => {
    expect(resolveImageSrc("/img/a.png", "/notes/d.md", toUrl)).toMatchObject({
      kind: "local",
      path: "/img/a.png",
    });
    expect(
      resolveImageSrc("img/a.png", "/notes/d.md", toUrl, "/blog"),
    ).toMatchObject({
      path: "/notes/img/a.png",
    });
  });

  it("with a root, /-rooted paths resolve under it and cannot escape it", () => {
    expect(
      resolveImageSrc(
        "/img/a.png",
        "/notes/d.md",
        toUrl,
        "/tmp/kalamos-test/blog",
      ),
    ).toMatchObject({
      kind: "local",
      path: "/tmp/kalamos-test/blog/img/a.png",
    });
    expect(
      resolveImageSrc("/../../etc/passwd", null, toUrl, "/blog"),
    ).toMatchObject({
      path: "/blog/etc/passwd",
    });
    // Untitled documents can still use rooted paths.
    expect(resolveImageSrc("/img/a.png", null, toUrl, "/blog").kind).toBe(
      "local",
    );
  });

  it("front matter typora-root-url wins over the setting; relative resolves against the doc", () => {
    expect(resolveImageRoot(null, "/n/d.md", "/blog")).toBe("/blog");
    expect(resolveImageRoot("/site", "/n/d.md", "/blog")).toBe("/site");
    expect(resolveImageRoot("../static", "/n/posts/d.md", "/blog")).toBe(
      "/n/static",
    );
    expect(resolveImageRoot("./", "/n/posts/d.md", null)).toBe("/n/posts");
    expect(resolveImageRoot("file:///a%20b", null, null)).toBe("/a b");
    // Relative front matter root in an untitled doc falls back to the setting.
    expect(resolveImageRoot("../static", null, "/blog")).toBe("/blog");
    expect(resolveImageRoot(null, null, null)).toBeNull();
    expect(resolveImageRoot("https://example.com", "/n/d.md", null)).toBeNull();
  });

  it("parses typora-root-url only from a closed front matter block at the top", () => {
    expect(
      findTyporaRootUrlInText(
        "---\ntitle: x\ntypora-root-url: ../static\n---\n# h",
      ),
    ).toBe("../static");
    expect(
      findTyporaRootUrlInText(`---\ntypora-root-url: "/my blog" # c\n...\n`),
    ).toBe("/my blog");
    expect(findTyporaRootUrlInText("---\ntypora-root-url: /x\n")).toBeNull(); // not closed
    expect(
      findTyporaRootUrlInText("\n---\ntypora-root-url: /x\n---"),
    ).toBeNull(); // not first line
    expect(
      findTyporaRootUrlInText("---\ntitle: a\n---\ntypora-root-url: /x"),
    ).toBeNull();
    expect(findTyporaRootUrlInText("# no front matter")).toBeNull();
  });

  it("effectiveImageRoot combines doc path, setting and front matter", () => {
    let state = stateOf("![](/img/a.png)");
    expect(effectiveImageRoot(state)).toBeNull();
    state = state.update({
      effects: setImageRootSettingEffect.of("/blog"),
    }).state;
    expect(effectiveImageRoot(state)).toBe("/blog");
    state = state.update({
      changes: { from: 0, insert: "---\ntypora-root-url: ../site\n---\n" },
      effects: setImageDocPathEffect.of("/n/posts/d.md"),
    }).state;
    expect(effectiveImageRoot(state)).toBe("/n/site");
  });
});

describe("IM-03 / IM-04 in PDF export", () => {
  it("export uses the same root and <img> sizes", async () => {
    const md = [
      "![a](/img/a.png)",
      "",
      `<img src="/img/b.png" style="zoom:50%" onerror="x()">`,
      "",
      `行內 <img src="c.png" width="120"> 圖`,
    ].join("\n");
    const { html } = await buildExportHtml(md, {
      title: "t",
      docPath: "/n/d.md",
      imageRootDir: "/blog",
    });
    expect(html).toContain('<img src="file:///blog/img/a.png" alt="a">');
    expect(html).toContain(
      '<img src="file:///blog/img/b.png" alt="" style="zoom:0.5">',
    );
    expect(html).toContain(
      '<img src="file:///n/c.png" alt="" style="width:120px">',
    );
    expect(html).not.toMatch(/onerror/);
  });

  it("front matter root overrides the setting in export", async () => {
    const md = "---\ntypora-root-url: ../site\n---\n\n![a](/img/a.png)";
    const { html } = await buildExportHtml(md, {
      title: "t",
      docPath: "/n/posts/d.md",
      imageRootDir: "/blog",
    });
    expect(html).toContain('src="file:///n/site/img/a.png"');
  });
});

describe("IM-04 root folder command", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("picking a folder sets the root, allows it, shows it and persists it; clearing resets", async () => {
    app = createKalamosApp(document);
    await app.init();
    setMockDialogHandlers({ openFolder: () => "/tmp/kalamos-test/blog" });

    expect(await app.pickImageRootDir()).toBe(true);
    expect(app.getImageRootDir()).toBe("/tmp/kalamos-test/blog");
    expect(app.getStatusText()).toBe("圖片根目錄：/tmp/kalamos-test/blog");
    expect(getMockAllowedAssetDirs()).toContain("/tmp/kalamos-test/blog");
    expect((await getSettings()).imageRootDir).toBe("/tmp/kalamos-test/blog");

    app.editor.setContent("![](/img/a.png)\n\nend");
    app.editor.setCursor(app.editor.view.state.doc.length);
    const img =
      app.editor.view.contentDOM.querySelector<HTMLImageElement>(
        "img.k-image-img",
      );
    expect(decodeURIComponent(img!.src)).toContain(
      "/tmp/kalamos-test/blog/img/a.png",
    );

    await app.setImageRootDir(null);
    expect(app.getImageRootDir()).toBeNull();
    expect(app.getStatusText()).toBe("已清除圖片根目錄");
    expect((await getSettings()).imageRootDir).toBeNull();
  });

  it("cancelling the picker keeps the current root", async () => {
    app = createKalamosApp(document);
    await app.init();
    await app.setImageRootDir("/blog");
    setMockDialogHandlers({ openFolder: () => null });
    expect(await app.pickImageRootDir()).toBe(false);
    expect(app.getImageRootDir()).toBe("/blog");
  });

  it("Cmd+Opt+R opens the picker, Cmd+Opt+Shift+R clears; the root is restored from settings", async () => {
    app = createKalamosApp(document);
    await app.init();
    setMockDialogHandlers({ openFolder: () => "/site" });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "®",
        code: "KeyR",
        metaKey: true,
        altKey: true,
      }),
    );
    await flush();
    await flush();
    expect(app.getImageRootDir()).toBe("/site");
    app.destroy();

    app = createKalamosApp(document);
    await app.init();
    expect(app.getImageRootDir()).toBe("/site");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "R",
        code: "KeyR",
        metaKey: true,
        altKey: true,
        shiftKey: true,
      }),
    );
    await flush();
    expect(app.getImageRootDir()).toBeNull();
  });

  it("a front matter root is allowed for the asset protocol when it comes into effect", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent(
      "---\ntypora-root-url: /static/site\n---\n\n![](/a.png)",
    );
    await flush();
    expect(getMockAllowedAssetDirs()).toContain("/static/site");
  });

  it("mock allowAssetDir refuses / and the home folder or its ancestors (like Rust)", async () => {
    for (const p of ["/", "/Users", MOCK_HOME_DIR]) {
      const err = await allowAssetDir(p).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isAssetDirTooBroadError(err), p).toBe(true);
    }
    await expect(allowAssetDir(`${MOCK_HOME_DIR}/blog`)).resolves.toBeNull();
    await expect(allowAssetDir("/tmp/x")).resolves.toBeNull();
    expect(getMockAllowedAssetDirs()).not.toContain("/");
  });

  it("a too-broad root from the setting shows a status message; images still render a widget", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent("![a](/img/a.png)\n\nend");
    app.editor.setCursor(app.editor.view.state.doc.length);
    setMockDialogHandlers({ openFolder: () => MOCK_HOME_DIR });
    expect(await app.pickImageRootDir()).toBe(true);
    await flush();
    expect(app.getStatusText()).toBe(`圖片根目錄範圍過大：${MOCK_HOME_DIR}`);
    expect(getMockAllowedAssetDirs()).not.toContain(MOCK_HOME_DIR);
    const widget = app.editor.view.contentDOM.querySelector<HTMLElement>(
      "[data-testid=image-widget]",
    );
    expect(widget?.dataset.path).toBe(`${MOCK_HOME_DIR}/img/a.png`);
  });

  it("a too-broad root from front matter shows a status message without crashing", async () => {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent(
      "---\ntypora-root-url: /\n---\n\n![a](/img/a.png)\n\nend",
    );
    app.editor.setCursor(app.editor.view.state.doc.length);
    await flush();
    await flush();
    expect(app.getStatusText()).toBe("圖片根目錄範圍過大：/");
    expect(getMockAllowedAssetDirs()).not.toContain("/");
    expect(
      app.editor.view.contentDOM.querySelector("[data-testid=image-widget]"),
    ).not.toBeNull();

    // A relative front matter root that climbs to the home folder is refused too.
    await app.saveDocumentAs(`${MOCK_HOME_DIR}/posts/doc.md`);
    app.editor.setContent("---\ntypora-root-url: ..\n---\n\n![a](/img/a.png)");
    await flush();
    await flush();
    expect(app.getStatusText()).toBe(`圖片根目錄範圍過大：${MOCK_HOME_DIR}`);
  });
});
