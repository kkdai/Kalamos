import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import {
  emitMockMenuAction,
  getMockClipboardHtml,
  getMockUploadCalls,
  resetMockState,
  seedMockFile,
  seedMockImageDataUri,
  seedMockUploadSettings,
  setMockClipboardHtmlHandler,
  setMockUploadHandler,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { createExportParseState } from "./html";
import {
  buildRichTextHtml,
  extractRichTextSource,
  formatCopyRichTextStatus,
  prepareDiagramSvg,
  prepareMathJaxSvg,
  type SvgRasterizer,
  stripLeadingFrontMatter,
} from "./rich-text";

const FAKE_PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

const fakeRasterizer: SvgRasterizer = async (_svg, opts) => ({
  dataUri: FAKE_PNG_URI,
  width: opts.width,
  height: opts.height,
});

function stateWithSelection(doc: string, from?: number, to?: number) {
  const base = createExportParseState(doc);
  const state =
    from !== undefined && to !== undefined
      ? base.update({ selection: EditorSelection.single(from, to) }).state
      : base;
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

describe("#144 extractRichTextSource & front matter stripping", () => {
  it("strips YAML front matter from whole-document copies while preserving typora-root-url", () => {
    const doc = [
      "---",
      "title: Blog Post",
      "typora-root-url: /blog/static",
      "---",
      "",
      "# Heading",
      "",
      "Body text.",
    ].join("\n");

    const source = extractRichTextSource(stateWithSelection(doc));
    expect(source.scope).toBe("document");
    expect(source.markdown).toBe("# Heading\n\nBody text.");
    expect(source.frontMatterImageRoot).toBe("/blog/static");
    expect(stripLeadingFrontMatter(doc)).toBe("# Heading\n\nBody text.");
  });

  it("strips front matter even when the user selects all (0..doc.length)", () => {
    const doc = "---\ntitle: Draft\n---\n\nHello **world**";
    const source = extractRichTextSource(
      stateWithSelection(doc, 0, doc.length),
    );
    expect(source.scope).toBe("selection");
    expect(source.markdown).toBe("Hello **world**");
  });

  it("returns only the selected slice when text is selected after front matter", () => {
    const doc =
      "---\ntitle: Draft\n---\n\n# Intro\n\nSelected *part* here.\n\nEnd.";
    const start = doc.indexOf("Selected");
    const end = doc.indexOf("here.") + "here.".length;
    const source = extractRichTextSource(stateWithSelection(doc, start, end));
    expect(source.scope).toBe("selection");
    expect(source.markdown).toBe("Selected *part* here.");
  });

  it("returns empty markdown when only front matter is selected or present", () => {
    const doc = "---\ntitle: Only FM\n---";
    expect(extractRichTextSource(stateWithSelection(doc)).markdown).toBe("");
    const withBody = "---\ntitle: FM\n---\n\nBody";
    const onlyFm = extractRichTextSource(stateWithSelection(withBody, 0, 14));
    expect(onlyFm.markdown).toBe("");
  });

  it("does not strip horizontal rules when not at the start of the document", () => {
    const doc = "# Title\n\n---\n\nParagraph\n\n---";
    expect(stripLeadingFrontMatter(doc)).toBe(doc);
  });
});

describe("#144 buildRichTextHtml conversion", () => {
  beforeEach(() => {
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  it("produces clean inline-styled HTML without theme CSS, <style>, or front matter", async () => {
    const md = [
      "---",
      "title: Secret FM",
      "---",
      "",
      "# Title",
      "",
      "A **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).",
      "",
      "> Quoted paragraph.",
      "",
      "- bullet 1",
      "- bullet 2",
      "",
      "2. second",
      "3. third",
      "",
      "- [x] Done task",
      "- [ ] Open task",
      "",
      "---",
    ].join("\n");

    const { html, plainText } = await buildRichTextHtml(md, {
      docPath: "/notes/post.md",
      rasterizeSvg: fakeRasterizer,
    });

    expect(plainText).not.toContain("Secret FM");
    expect(html).not.toContain("Secret FM");
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("var(--k-");
    expect(html).not.toMatch(/\bclass="/);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>strike</del>");
    expect(html).toMatch(/<code style="[^"]*monospace[^"]*">code<\/code>/);
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toMatch(/<blockquote style="[^"]*border-left:[^"]*">/);
    expect(html).toContain("<ul>");
    expect(html).toContain('<ol start="2">');
    expect(html).toContain('<li style="list-style:none;">☑ Done task</li>');
    expect(html).toContain('<li style="list-style:none;">☐ Open task</li>');
    expect(html).toMatch(/<hr style="/);
  });

  it("preserves monospace font, newlines, escaping, and inline syntax colors in code blocks", async () => {
    const md = '```js\nconst msg = "<b>hi</b>";\n  return msg;\n```\n';
    const { html } = await buildRichTextHtml(md, {
      docPath: null,
      rasterizeSvg: fakeRasterizer,
    });
    expect(html).toMatch(
      /<pre style="[^"]*monospace[^"]*white-space:pre-wrap[^"]*"><code style="[^"]*white-space:pre-wrap[^"]*">/,
    );
    expect(html).toContain(
      '<span style="color:#a4552f;font-weight:600;">const</span>',
    );
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("\n  ");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("renders GFM tables with inline borders, header background, and column alignment", async () => {
    const md =
      "| Left | Center | Right |\n| :--- | :---: | ---: |\n| 1 | | **3** |\n";
    const { html } = await buildRichTextHtml(md, {
      docPath: null,
      rasterizeSvg: fakeRasterizer,
    });
    expect(html).toContain(
      '<table style="border-collapse:collapse;margin:0.8em 0;">',
    );
    expect(html).toContain(
      '<th style="border:1px solid #d1d5db;padding:6px 10px;background-color:#f6f8fa;font-weight:600;text-align:left;">Left</th>',
    );
    expect(html).toContain(
      '<th style="border:1px solid #d1d5db;padding:6px 10px;background-color:#f6f8fa;font-weight:600;text-align:center;">Center</th>',
    );
    expect(html).toContain(
      '<th style="border:1px solid #d1d5db;padding:6px 10px;background-color:#f6f8fa;font-weight:600;text-align:right;">Right</th>',
    );
    expect(html).toContain(
      '<td style="border:1px solid #d1d5db;padding:6px 10px;text-align:right;"><strong>3</strong></td>',
    );
  });

  it("rasterizes inline and block math to PNG images and falls back to TeX when unavailable", async () => {
    const md =
      "Euler $e^{i\\pi}+1=0$ and[^1].\n\n[^1]: Note $a^2+b^2$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n";
    const { html } = await buildRichTextHtml(md, {
      docPath: null,
      rasterizeSvg: fakeRasterizer,
    });

    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<mjx-container");
    expect(html).toMatch(
      /<img src="data:image\/png;base64,[^"]+" alt="e\^\{i\\pi\}\+1=0" width="\d+" height="\d+" style="vertical-align:-?[\d.]+px;display:inline;">/,
    );
    expect(html).toMatch(
      /<p style="text-align:center;margin:0\.8em 0;"><img src="data:image\/png;base64,[^"]+" alt="\\int_0\^1 x\\,dx" width="\d+" height="\d+" style="max-width:100%;height:auto;"><\/p>/,
    );
    // Footnote formula stays in the footnote list, not swapped into body.
    const bodyBeforeHr = html.slice(0, html.indexOf("<hr "));
    const footnoteAfterHr = html.slice(html.indexOf("<hr "));
    expect(bodyBeforeHr).toContain('alt="e^{i\\pi}+1=0"');
    expect(bodyBeforeHr).not.toContain('alt="a^2+b^2"');
    expect(footnoteAfterHr).toContain('alt="a^2+b^2"');

    // Graceful fallback to original TeX when rasterizer returns null.
    const fallback = await buildRichTextHtml(
      "Inline $x+1$ and\n\n$$\ny=2\n$$",
      {
        docPath: null,
        rasterizeSvg: async () => null,
      },
    );
    expect(fallback.html).toContain("$x+1$");
    expect(fallback.html).toContain("$$");
    expect(fallback.html).toContain("y=2");
  }, 30_000);

  it("embeds local images as size-limited data URIs when no uploader is configured", async () => {
    seedMockImageDataUri("/notes/assets/small.png", FAKE_PNG_URI, 512);
    seedMockImageDataUri(
      "/notes/assets/huge.png",
      "data:image/png;base64,HUGE",
      5 * 1024 * 1024,
    );

    const md = [
      "![small](assets/small.png)",
      "![again](assets/small.png)",
      "![huge](assets/huge.png)",
      "![missing](assets/missing.png)",
      "![remote](https://example.com/pic.png)",
      '<img src="assets/small.png" alt="sized" width="200">',
    ].join("\n\n");

    const { html, images } = await buildRichTextHtml(md, {
      docPath: "/notes/post.md",
      rasterizeSvg: fakeRasterizer,
    });

    expect(images).toEqual({
      uploaded: 0,
      embedded: 1,
      skipped: 2,
      uploadFailed: false,
    });
    expect(html).toContain(
      `<img src="${FAKE_PNG_URI}" alt="small" style="max-width:100%;height:auto;">`,
    );
    expect(html).toContain(
      `<img src="${FAKE_PNG_URI}" alt="sized" style="max-width:100%;height:auto;width:200px">`,
    );
    expect(html).toContain(
      '<img src="https://example.com/pic.png" alt="remote" style="max-width:100%;height:auto;">',
    );
    expect(html).toContain("[huge]");
    expect(html).toContain("[missing]");
    expect(html).not.toContain("file://");
  });

  it("uploads local images when uploadCommand is configured and falls back if upload fails", async () => {
    seedMockImageDataUri("/blog/static/img/hero.png", FAKE_PNG_URI, 300);
    const md = [
      "---",
      "typora-root-url: /blog/static",
      "---",
      "",
      "![hero](/img/hero.png)",
    ].join("\n");

    const uploadedUrls: string[] = [];
    const ok = await buildRichTextHtml(md, {
      docPath: "/blog/posts/a.md",
      uploadCommand: "/opt/homebrew/bin/picgo",
      uploadImages: async (paths) => {
        uploadedUrls.push(...paths);
        return { urls: ["https://cdn.example.com/hero.png"] };
      },
      rasterizeSvg: fakeRasterizer,
    });

    expect(uploadedUrls).toEqual(["/blog/static/img/hero.png"]);
    expect(ok.images).toEqual({
      uploaded: 1,
      embedded: 0,
      skipped: 0,
      uploadFailed: false,
    });
    expect(ok.html).toContain('src="https://cdn.example.com/hero.png"');

    // If upload throws, fall back to local data URI embedding.
    const fallback = await buildRichTextHtml(md, {
      docPath: "/blog/posts/a.md",
      uploadCommand: "/opt/homebrew/bin/picgo",
      uploadImages: async () => {
        throw new Error("offline");
      },
      rasterizeSvg: fakeRasterizer,
    });
    expect(fallback.images).toEqual({
      uploaded: 0,
      embedded: 1,
      skipped: 0,
      uploadFailed: true,
    });
    expect(fallback.html).toContain(`src="${FAKE_PNG_URI}"`);
  });

  it("blocks XSS payloads in headings, raw HTML, links, and images", async () => {
    const md = [
      "# <script>alert(1)</script>",
      "",
      '<img src="https://example.com/a.png" onerror="alert(2)">',
      "",
      "[bad](javascript:alert(3))",
      "",
      "![bad](javascript:alert(4))",
    ].join("\n");
    const { html } = await buildRichTextHtml(md, {
      docPath: "/notes/a.md",
      rasterizeSvg: fakeRasterizer,
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>bad</span>");
  });

  it("normalizes MathJax and Mermaid SVGs with explicit pixel sizes and xmlns", () => {
    const mjx = prepareMathJaxSvg(
      '<mjx-container><svg style="vertical-align: -0.5ex;" width="10ex" height="2ex" viewBox="0 -700 4400 880"><g fill="currentColor"></g></svg></mjx-container>',
    );
    expect(mjx).not.toBeNull();
    expect(mjx!.width).toBe(85);
    expect(mjx!.height).toBe(17);
    expect(mjx!.verticalAlignPx).toBe(-4.2);
    expect(mjx!.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(mjx!.svg).not.toContain("currentColor");

    const diag = prepareDiagramSvg(
      '<svg id="m1" width="100%" viewBox="0 0 320.4 180.2"><rect/></svg>',
    );
    expect(diag).toEqual({
      svg: '<svg width="321" height="181" xmlns="http://www.w3.org/2000/svg" id="m1" viewBox="0 0 320.4 180.2"><rect/></svg>',
      width: 321,
      height: 181,
    });
  });

  it("formats status messages in both zh-TW and en", () => {
    initUiLocale("zh-TW");
    expect(
      formatCopyRichTextStatus("document", {
        uploaded: 0,
        embedded: 0,
        skipped: 0,
        uploadFailed: false,
      }),
    ).toBe("已複製為富文字");
    expect(
      formatCopyRichTextStatus("selection", {
        uploaded: 0,
        embedded: 2,
        skipped: 0,
        uploadFailed: false,
      }),
    ).toBe(
      "已複製選取內容為富文字（已內嵌 2 張本機圖片，部分網站可能無法顯示）",
    );

    initUiLocale("en");
    expect(
      formatCopyRichTextStatus("document", {
        uploaded: 1,
        embedded: 0,
        skipped: 1,
        uploadFailed: false,
      }),
    ).toBe(
      "Copied as rich text (uploaded 1 local image; 1 local image exceeded the size limit or could not be read)",
    );
  });
});

describe("#144 Copy as Rich Text app integration", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
    document.body.innerHTML = `
      <div id="app">
        <main id="editor-container"></main>
        <div id="status" data-testid="status" role="status"></div>
      </div>
    `;
    app = createKalamosApp(document);
    await app.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app?.destroy();
    app = null;
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  it("runs from menu edit.copyRichText and keyboard Cmd+Opt+Shift+C without duplicating", async () => {
    seedMockFile(
      "/notes/article.md",
      "---\ntitle: Meta\n---\n\n# Hello\n\nParagraph with **bold**.\n",
    );
    await app!.openDocument("/notes/article.md");

    // 1. Trigger via menu action (whole document).
    await emitMockMenuAction("edit.copyRichText");
    await vi.waitFor(() => {
      expect(app!.getStatusText()).toBe("已複製為富文字");
    });
    const first = getMockClipboardHtml()!;
    expect(first.plainText).toBe("# Hello\n\nParagraph with **bold**.\n");
    expect(first.html).toContain("<h1>Hello</h1>");
    expect(first.html).toContain("<strong>bold</strong>");
    expect(first.html).not.toContain("Meta");

    // 2. Select only the paragraph and trigger via Cmd+Opt+Shift+C; follow with duplicate menu event.
    const docText = app!.editor.getContent();
    const from = docText.indexOf("Paragraph");
    const to = docText.length;
    app!.editor.view.dispatch({ selection: { anchor: from, head: to } });

    let writeCalls = 0;
    setMockClipboardHtmlHandler(() => {
      writeCalls += 1;
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Ç",
        code: "KeyC",
        metaKey: true,
        altKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    await emitMockMenuAction("edit.copyRichText");
    await vi.waitFor(() => {
      expect(app!.getStatusText()).toBe("已複製選取內容為富文字");
    });
    expect(writeCalls).toBe(1);
    const second = getMockClipboardHtml()!;
    expect(second.plainText).toBe("Paragraph with **bold**.\n");
    expect(second.html).not.toContain("<h1>Hello</h1>");
    expect(second.html).toContain("<strong>bold</strong>");
  });

  it("uploads local images into clipboard HTML when uploader is set without modifying the document", async () => {
    const md = "# Post\n\n![pic](assets/a.png)\n";
    seedMockFile("/notes/post.md", md);
    seedMockUploadSettings("/opt/homebrew/bin/picgo", ["upload"]);
    setMockUploadHandler(() => ({
      urls: ["https://cdn.kalamos.test/a.png"],
    }));
    await app!.openDocument("/notes/post.md");

    expect(await app!.copyRichText()).toBe(true);
    expect(getMockUploadCalls()).toEqual([["/notes/assets/a.png"]]);
    expect(getMockClipboardHtml()!.html).toContain(
      'src="https://cdn.kalamos.test/a.png"',
    );
    // The open Markdown document must remain untouched!
    expect(app!.editor.getContent()).toBe(md);
    expect(app!.getStatusText()).toBe("已複製為富文字（已上傳 1 張本機圖片）");
  });

  it("reports empty content and clipboard write errors cleanly", async () => {
    app!.editor.setContent("---\ntitle: Empty\n---\n", { dirty: false });
    expect(await app!.copyRichText()).toBe(false);
    expect(app!.getStatusText()).toBe("沒有可複製的內容");
    expect(getMockClipboardHtml()).toBeNull();

    app!.editor.setContent("# Hi", { dirty: false });
    setMockClipboardHtmlHandler(() => {
      throw new Error("clipboard denied");
    });
    expect(await app!.copyRichText()).toBe(false);
    expect(app!.getStatusText()).toBe("複製為富文字失敗：clipboard denied");
    expect(document.getElementById("status")!.dataset.error).toBe("true");
    expect(app!.isCopyingRichText()).toBe(false);
  });
});
