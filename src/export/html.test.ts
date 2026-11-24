import { describe, expect, it } from "vitest";
import { getUiLocale, initUiLocale } from "../i18n";
import {
  buildExportHtml,
  collectExportHeadings,
  escapeHtml,
  fileUrlFromPath,
} from "./html";
import { defaultPdfPath, documentTitle, ensurePdfExtension } from "./pdf";

async function render(md: string, docPath: string | null = "/notes/doc.md") {
  return buildExportHtml(md, { title: "doc", docPath });
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
}

describe("EX-01 export HTML", () => {
  it("gives headings GitHub-style slug ids (same as #5), with duplicates suffixed", async () => {
    const md =
      "# Hello World\n\n## 中文 標題\n\n## Hello World\n\nSetext\n---\n\n### **Bold** `code`\n";
    const { html, headings } = await render(md);
    expect(headings).toEqual([
      { level: 1, text: "Hello World", id: "hello-world" },
      { level: 2, text: "中文 標題", id: "中文-標題" },
      { level: 2, text: "Hello World", id: "hello-world-1" },
      { level: 2, text: "Setext", id: "setext" },
      { level: 3, text: "Bold code", id: "bold-code" },
    ]);
    expect(html).toContain('<h1 id="hello-world">Hello World</h1>');
    expect(html).toContain('<h2 id="中文-標題">中文 標題</h2>');
    expect(html).toContain('<h2 id="hello-world-1">Hello World</h2>');
    expect(html).toContain('<h2 id="setext">Setext</h2>');
    expect(html).toContain(
      '<h3 id="bold-code"><strong>Bold</strong> <code>code</code></h3>',
    );
    expect(collectExportHeadings(md)).toEqual(headings);
  });

  it("renders GFM tables with alignment and empty cells", async () => {
    const { html } = await render(
      "| a | b | c |\n|:-|:-:|-:|\n| 1 | | **3** |\n",
    );
    const body = bodyOf(html);
    expect(body).toContain('<table class="k-table">');
    expect(body).toContain(
      '<tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr>',
    );
    expect(body).toContain(
      '<tr><td style="text-align:left">1</td><td style="text-align:center"></td><td style="text-align:right"><strong>3</strong></td></tr>',
    );
  });

  it("renders bullet, ordered and task lists", async () => {
    const { html } = await render(
      "- a\n- b\n\n3. x\n4. y\n\n- [x] done\n- [ ] todo\n",
    );
    const body = bodyOf(html);
    expect(body).toMatch(/<ul>\n<li><p>a<\/p>\n<\/li>/);
    expect(body).toContain('<ol start="3">');
    expect(body).toContain(
      '<li class="k-task"><span class="k-task-box" data-checked="true">✓</span><span class="k-task-text">done</span></li>',
    );
    expect(body).toContain(
      '<li class="k-task"><span class="k-task-box" data-checked="false"></span><span class="k-task-text">todo</span></li>',
    );
  });

  it("highlights fenced code with token spans and escapes code text", async () => {
    const { html } = await render(
      '```js\nconst a = "<b>"; // hi\n```\n\n```\nplain <i>\n```\n',
    );
    const body = bodyOf(html);
    expect(body).toContain('<pre class="k-code" data-lang="js"><code>');
    expect(body).toContain('<span class="k-tok-keyword">const</span>');
    expect(body).toContain(
      '<span class="k-tok-string">&quot;&lt;b&gt;&quot;</span>',
    );
    expect(body).toContain('<span class="k-tok-comment">// hi</span>');
    expect(body).toContain(
      '<pre class="k-code"><code>plain &lt;i&gt;</code></pre>',
    );
    expect(body).not.toContain("<b>");
  });

  it("renders inline and block math as MathJax SVG", async () => {
    const { html } = await render(
      "Euler $e^{i\\pi}+1=0$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n",
    );
    const body = bodyOf(html);
    expect(body).toMatch(
      /<span class="k-math-inline"><mjx-container[^>]*><svg/,
    );
    expect(body).toMatch(
      /<div class="k-math-block"><mjx-container[^>]*display="true"[^>]*><svg/,
    );
  }, 30_000);

  it("never lets document content inject markup or scripts", async () => {
    const md = [
      "# <script>alert(1)</script>",
      "",
      "<script>alert(2)</script>",
      "",
      'Inline <img src=x onerror="alert(3)"> and <br> ok.',
      "",
      '[js](javascript:alert(4)) [ok](https://example.com "t\\"x")',
      "",
      '![a"b](javascript:alert(5))',
      "",
      "| <iframe> |\n|---|\n| x |",
    ].join("\n");
    const { html } = await render(md);
    const body = bodyOf(html);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<img src=x/i);
    expect(body).not.toMatch(/<iframe/i);
    expect(body).not.toContain("javascript:");
    expect(body).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    // IM-03: <img> is rebuilt from allow-listed attributes only (onerror dropped).
    expect(body).toContain(
      'Inline <img src="file:///notes/x" alt=""> and <br> ok.',
    );
    expect(body).not.toMatch(/onerror/i);
    expect(body).toContain('<span class="k-link">js</span>');
    expect(body).toContain('<a href="https://example.com"');
    expect(body).toContain('<span class="k-image-missing">[a&quot;b]</span>');
    // Title must be escaped too.
    const { html: titled } = await buildExportHtml("x", {
      title: "</title><script>",
      docPath: null,
    });
    expect(titled).toContain("<title>&lt;/title&gt;&lt;script&gt;</title>");
  });

  it("resolves local images to file:// URLs and keeps remote / data URLs", async () => {
    const { html } = await render(
      "![cat](assets/my%20cat.png) ![r](https://x.test/a.png) ![d](data:image/png;base64,AAAA)",
      "/notes/doc.md",
    );
    expect(html).toContain(
      '<img src="file:///notes/assets/my%20cat.png" alt="cat">',
    );
    expect(html).toContain('<img src="https://x.test/a.png" alt="r">');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="d">');
    const untitled = await render("![cat](assets/cat.png)", null);
    expect(untitled.html).toContain(
      '<span class="k-image-missing">[cat]</span>',
    );
  });

  it("produces a standalone page with print CSS and a restrictive CSP", async () => {
    const { html } = await render("hello");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("@page");
    expect(html).toContain("size: A4");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("<p>hello</p>");
  });

  it("localizes diagram error punctuation and escapes detail text in exported HTML", async () => {
    const prev = getUiLocale();
    const md = "```flow\nnot a valid <script> flow\n```\n";
    try {
      initUiLocale("zh-TW");
      const zh = await render(md);
      expect(zh.html).toContain(
        '<p class="k-diagram-error">圖表語法錯誤（第 1 行）：',
      );
      expect(zh.html).not.toContain("<script>");

      initUiLocale("en");
      const en = await render(md);
      expect(en.html).toContain(
        '<p class="k-diagram-error">Diagram syntax error (line 1): ',
      );
      expect(en.html).not.toContain("）：");
      expect(en.html).not.toContain(")：");
      expect(en.html).not.toContain("<script>");
    } finally {
      initUiLocale(prev);
    }
  });
});

describe("EX-01 helpers", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("builds file URLs and default PDF paths", () => {
    expect(fileUrlFromPath("/a b/c#d.png")).toBe("file:///a%20b/c%23d.png");
    expect(defaultPdfPath("/notes/My Doc.md")).toBe("/notes/My Doc.pdf");
    expect(defaultPdfPath(null)).toBe("未命名.pdf");
    expect(documentTitle("/x/readme.markdown")).toBe("readme");
    expect(ensurePdfExtension("/x/out")).toBe("/x/out.pdf");
    expect(ensurePdfExtension("/x/out.PDF")).toBe("/x/out.PDF");
  });
});
