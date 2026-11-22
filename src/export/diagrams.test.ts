import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mermaid needs real layout, so it is mocked (as in src/editor/diagrams.test.ts);
// DOMPurify is real. The fake SVG carries hostile bits and Mermaid-style ids.
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (text: string) => {
    const bad = text.split("\n").findIndex((l) => l.includes("BAD"));
    if (bad >= 0) {
      const err = new Error(
        `Parse error on line ${bad + 1}:\n...BAD\n---^\nExpecting 'SPACE'`,
      ) as Error & {
        hash: unknown;
      };
      err.hash = { loc: { first_line: bad + 1 } };
      throw err;
    }
    return { diagramType: "flowchart" };
  }),
  render: vi.fn(async (id: string, text: string) => ({
    svg:
      `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 320px;" ` +
      `viewBox="0 0 320 200" aria-labelledby="chart-title-${id}" onload="alert(1)">` +
      `<title id="chart-title-${id}">t</title>` +
      `<script>alert(1)</script><style>#${id} .node{fill:#f7f3ea;}#${id} .edge{stroke:#333;}</style>` +
      `<defs><marker id="${id}_flowchart-pointEnd"><path d="M0 0"/></marker></defs>` +
      `<g class="node" onclick="alert(2)"><rect/><text>${text.split("\n").length} lines: one = two</text></g>` +
      `<path marker-end="url(#${id}_flowchart-pointEnd)"/>` +
      `<foreignObject><div>html</div></foreignObject></svg>`,
  })),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

import {
  clearDiagramCache,
  readDiagramTheme,
  renderDiagram,
} from "../editor/diagrams";
import { isStaticSvg, PRINT_DIAGRAM_THEME, scopeSvgIds } from "./diagrams";
import { buildExportHtml } from "./html";

const body = (html: string) =>
  html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
const fence = (info: string, src: string) => `\`\`\`${info}\n${src}\n\`\`\``;

beforeEach(() => {
  clearDiagramCache();
  mermaidMock.initialize.mockClear();
  mermaidMock.render.mockClear();
});

afterEach(() => {
  document.documentElement.style.removeProperty("--k-bg");
});

describe("#37 diagrams in the export HTML", () => {
  it("renders mermaid, flow and sequence fences as inline SVG figures", async () => {
    const md = [
      "# Diagrams",
      fence("mermaid", "flowchart TD\n  A --> B"),
      fence("flow", "st=>start: Start\ne=>end: End\nst->e"),
      fence("sequence", "Alice->Bob: Hello"),
      fence("js", "let notADiagram = 1;"),
    ].join("\n\n");
    const html = body(
      (await buildExportHtml(md, { title: "t", docPath: null })).html,
    );
    const figures =
      html.match(/<figure class="k-diagram" data-kind="(\w+)"><svg/g) ?? [];
    expect(figures).toHaveLength(3);
    expect(html).toContain('data-kind="mermaid"');
    expect(html).toContain('data-kind="flow"');
    expect(html).toContain('data-kind="sequence"');
    expect(html).toContain('<pre class="k-code" data-lang="js">');
    // flow / sequence were translated to Mermaid before rendering.
    const sources = mermaidMock.render.mock.calls.map((c) => String(c[1]));
    expect(sources[1].startsWith("flowchart")).toBe(true);
    expect(sources[2].startsWith("sequenceDiagram")).toBe(true);
  });

  it("exports a broken diagram as its code plus a short red error line", async () => {
    const md = fence("mermaid", "flowchart TD\n  A --> BAD");
    const html = body(
      (await buildExportHtml(md, { title: "t", docPath: null })).html,
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain(
      '<pre class="k-code" data-lang="mermaid"><code>flowchart TD\n  A --&gt; BAD</code></pre>',
    );
    expect(html).toContain(
      '<p class="k-diagram-error">圖表語法錯誤（第 2 行）：Parse error on line 2:</p>',
    );
  });

  it("an unclosed fence stays plain code", async () => {
    const html = body(
      (
        await buildExportHtml("```mermaid\nflowchart TD\nA-->B", {
          title: "t",
          docPath: null,
        })
      ).html,
    );
    expect(html).not.toContain("<svg");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("never outputs scripts, foreignObject or event handlers", async () => {
    const md = [
      fence("mermaid", "flowchart TD\nA-->B"),
      fence("sequence", "A->B: hi"),
    ].join("\n\n");
    const html = body(
      (await buildExportHtml(md, { title: "t", docPath: null })).html,
    );
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/foreignObject/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).toContain("one = two"); // label text is untouched
  });

  it("gives every diagram its own ids, even identical (cached) ones", async () => {
    const same = fence("mermaid", "flowchart TD\nA-->B");
    const html = body(
      (
        await buildExportHtml(`${same}\n\n${same}`, {
          title: "t",
          docPath: null,
        })
      ).html,
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(1); // second one came from the cache
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.filter((id) => id.startsWith("k-export-diagram-1-")),
    ).toHaveLength(3);
    expect(
      ids.filter((id) => id.startsWith("k-export-diagram-2-")),
    ).toHaveLength(3);
    // References and style selectors follow the renamed ids.
    for (const m of html.matchAll(/url\(#([^)]+)\)|#(k-export-[\w-]+)\s/g)) {
      expect(ids).toContain(m[1] ?? m[2]);
    }
    expect(html).not.toContain("k-mermaid-");
  });

  it("uses the light print theme even when the editor theme is dark", async () => {
    document.documentElement.style.setProperty("--k-bg", "#1C1A17");
    const editorTheme = readDiagramTheme();
    expect(editorTheme.dark).toBe(true);
    // The editor last rendered with its dark theme…
    await renderDiagram("mermaid", "flowchart TD\nX-->Y", editorTheme);
    expect(mermaidMock.initialize.mock.calls.at(-1)?.[0].darkMode).toBe(true);
    // …the export still switches Mermaid to the light print theme.
    await buildExportHtml(fence("mermaid", "flowchart TD\nA-->B"), {
      title: "t",
      docPath: null,
    });
    const config = mermaidMock.initialize.mock.calls.at(-1)?.[0] as {
      darkMode: boolean;
      themeVariables: Record<string, unknown>;
      securityLevel: string;
      htmlLabels: boolean;
    };
    expect(config.darkMode).toBe(false);
    expect(config.themeVariables.background).toBe("#ffffff");
    expect(config.themeVariables.primaryTextColor).toBe("#2b2622");
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(PRINT_DIAGRAM_THEME.dark).toBe(false);
  });

  it("renders 20 diagrams sequentially in reasonable time", async () => {
    const md = Array.from({ length: 20 }, (_, i) =>
      fence("mermaid", `flowchart TD\nA${i}-->B${i}`),
    ).join("\n\n");
    const t0 = performance.now();
    const html = (await buildExportHtml(md, { title: "t", docPath: null }))
      .html;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(html.match(/<figure class="k-diagram"/g)).toHaveLength(20);
    expect(mermaidMock.render).toHaveBeenCalledTimes(20);
  });
});

describe("#37 helpers", () => {
  it("scopeSvgIds renames ids, url()/href/CSS references and aria lists", () => {
    const svg =
      '<svg id="m-1" aria-labelledby="t-m-1 d-m-1"><title id="t-m-1"/><desc id="d-m-1"/>' +
      '<style>#m-1 .a{fill:#fff}#m-10{}</style><use href="#m-1_x"/><marker id="m-1_x"/>' +
      '<path marker-end="url(#m-1_x)"/></svg>';
    const out = scopeSvgIds(svg, "p");
    expect(out).not.toMatch(/m-1(?!0)/);
    expect(out).toContain("fill:#fff");
    expect(out).toContain("#m-10{}"); // not an id in this SVG: untouched
    const ids = [...out.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.every((id) => id.startsWith("p-"))).toBe(true);
    expect(out).toMatch(/aria-labelledby="p-\d+ p-\d+"/);
  });

  it("isStaticSvg rejects executable content but not label text", () => {
    expect(
      isStaticSvg("<svg><text>one = two, javascript: rocks</text></svg>"),
    ).toBe(true);
    expect(isStaticSvg("<svg><script>x</script></svg>")).toBe(false);
    expect(isStaticSvg('<svg onload="x"></svg>')).toBe(false);
    expect(isStaticSvg("<svg><foreignObject/></svg>")).toBe(false);
    expect(isStaticSvg('<svg><a href="javascript:x"/></svg>')).toBe(false);
  });
});
