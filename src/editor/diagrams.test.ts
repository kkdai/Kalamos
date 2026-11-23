import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mermaid needs real layout (getBBox etc.), so it is mocked in jsdom. The
// real DOMPurify is used, so sanitisation is exercised for real.
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (text: string) => {
    const lines = text.split("\n");
    const bad = lines.findIndex((l) => l.includes("BAD"));
    if (bad >= 0) {
      const err = new Error(
        `Parse error on line ${bad + 1}:\n...BAD\n---^`,
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
      `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" onload="alert(1)">` +
      `<script>alert(1)</script><style>#${id}{fill:red}</style>` +
      `<g class="node"><text>${text.length}</text></g></svg>`,
  })),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

import {
  buildDiagramDecorations,
  clearDiagramCache,
  collectDiagramBlocks,
  type DiagramTheme,
  DiagramWidget,
  diagramRefreshEffect,
  diagramStateField,
  flowToMermaid,
  getCachedDiagram,
  getDiagramCacheSize,
  isDiagramEngineLoaded,
  MAX_DIAGRAM_CACHE_ENTRIES,
  mermaidConfig,
  readDiagramTheme,
  renderDiagram,
  resolveDiagramKind,
  sequenceToMermaid,
  setDiagramThemeEffect,
} from "./diagrams";
import { createSourceModeController } from "./source-mode";

const FLOW_DOC = "前言\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nend";

function createState(doc: string, cursor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), diagramStateField],
  });
}

interface WidgetInfo {
  from: number;
  to: number;
  widget: DiagramWidget;
}

function widgets(state: EditorState): WidgetInfo[] {
  const out: WidgetInfo[] = [];
  state
    .field(diagramStateField)
    .decorations.between(0, state.doc.length, (from, to, v) => {
      const w = v.spec.widget;
      if (w instanceof DiagramWidget) out.push({ from, to, widget: w });
    });
  return out;
}

function theme(overrides: Partial<DiagramTheme["colors"]> = {}): DiagramTheme {
  const base = readDiagramTheme();
  const colors = { ...base.colors, ...overrides };
  return { ...base, colors, key: JSON.stringify(colors) };
}

function mount(doc: string, cursor = doc.length): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: createState(doc, cursor), parent });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clearDiagramCache();
  mermaidMock.parse.mockClear();
  mermaidMock.render.mockClear();
  mermaidMock.initialize.mockClear();
});

describe("lazy loading", () => {
  // Must run first: the engine is a module-level singleton.
  it("documents without diagrams never load Mermaid", async () => {
    const view = mount("# 標題\n\n```js\nlet a;\n```\n\n$x$");
    await settle();
    expect(view.dom.querySelector(".k-diagram")).toBeNull();
    expect(isDiagramEngineLoaded()).toBe(false);
    expect(mermaidMock.initialize).not.toHaveBeenCalled();
  });
});

describe("block detection", () => {
  it("recognises mermaid / flow / sequence info strings", () => {
    expect(resolveDiagramKind("mermaid")).toBe("mermaid");
    expect(resolveDiagramKind(" Mermaid  {.wide}")).toBe("mermaid");
    expect(resolveDiagramKind("flow")).toBe("flow");
    expect(resolveDiagramKind("sequence")).toBe("sequence");
    expect(resolveDiagramKind("js")).toBeNull();
    expect(resolveDiagramKind("")).toBeNull();
  });

  it("collects closed blocks with their source; unclosed fences are ignored", () => {
    const state = createState(FLOW_DOC);
    const blocks = collectDiagramBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe("flowchart TD\n  A --> B");
    expect(blocks[0].active).toBe(false);
    expect(
      collectDiagramBlocks(createState("```mermaid\nflowchart TD\nA-->B")),
    ).toHaveLength(0);
  });
});

describe("decorations", () => {
  it("cursor outside: the whole fence is replaced by one block widget", () => {
    const state = createState(FLOW_DOC);
    const ws = widgets(state);
    expect(ws).toHaveLength(1);
    expect(ws[0].widget.isPreview).toBe(false);
    expect(state.sliceDoc(ws[0].from, ws[0].to)).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );
  });

  it("cursor inside: source stays, a preview widget follows the closing fence", () => {
    const pos = FLOW_DOC.indexOf("A -->");
    const state = createState(FLOW_DOC, pos);
    const ws = widgets(state);
    expect(ws).toHaveLength(1);
    expect(ws[0].widget.isPreview).toBe(true);
    expect(ws[0].from).toBe(ws[0].to);
    expect(ws[0].from).toBe(FLOW_DOC.indexOf("```\n\nend") + 3);
  });

  it("moving the cursor in and out switches widget kind", () => {
    let state = createState(FLOW_DOC);
    state = state.update({
      selection: { anchor: FLOW_DOC.indexOf("A -->") },
    }).state;
    expect(widgets(state)[0].widget.isPreview).toBe(true);
    state = state.update({ selection: { anchor: 0 } }).state;
    expect(widgets(state)[0].widget.isPreview).toBe(false);
  });

  it("typing inside updates the preview source", () => {
    const pos = FLOW_DOC.indexOf("A --> B") + "A --> B".length;
    let state = createState(FLOW_DOC, pos);
    state = state.update({
      changes: { from: pos, insert: "\n  B --> C" },
      userEvent: "input.type",
    }).state;
    expect(widgets(state)[0].widget.source).toBe(
      "flowchart TD\n  A --> B\n  B --> C",
    );
  });

  it("IME composition maps decorations without rebuilding; compositionend refreshes", () => {
    const pos = FLOW_DOC.indexOf("A --> B") + "A --> B".length;
    let state = createState(FLOW_DOC, pos);
    const before = widgets(state)[0].widget;
    state = state.update({
      changes: { from: pos, insert: "ㄅ" },
      selection: { anchor: pos + 1 },
      userEvent: "input.type.compose",
    }).state;
    expect(widgets(state)[0].widget).toBe(before);
    state = state.update({ effects: diagramRefreshEffect.of(null) }).state;
    expect(widgets(state)[0].widget.source).toContain("A --> Bㄅ");
  });

  it("a theme change rebuilds widgets with the new theme", () => {
    let state = createState(FLOW_DOC);
    const t = theme({ bg: "#1C1A17" });
    state = state.update({ effects: setDiagramThemeEffect.of(t) }).state;
    expect(widgets(state)[0].widget.theme.key).toBe(t.key);
  });

  it("buildDiagramDecorations covers every diagram kind", () => {
    const doc =
      "```flow\na=>start: A\n```\n\n```sequence\nA->B: hi\n```\n\n```mermaid\ngantt\n```\n\nx";
    const set = buildDiagramDecorations(createState(doc));
    const kinds: string[] = [];
    set.between(0, doc.length, (_f, _t, v) => {
      kinds.push((v.spec.widget as DiagramWidget).kind);
    });
    expect(kinds).toEqual(["flow", "sequence", "mermaid"]);
  });
});

describe("rendering", () => {
  it("mounting a diagram loads Mermaid with strict security and shows sanitised SVG", async () => {
    const view = mount(FLOW_DOC);
    try {
      const el = await vi.waitFor(() => {
        const widget = view.dom.querySelector<HTMLElement>(
          "[data-testid=diagram]",
        );
        expect(widget?.dataset.state).toBe("rendered");
        return widget!;
      });
      expect(isDiagramEngineLoaded()).toBe(true);
      const cfg = mermaidMock.initialize.mock.calls[0][0];
      expect(cfg).toMatchObject({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
      });
      const svg = el.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(el.querySelector("script")).toBeNull();
      expect(svg!.getAttribute("onload")).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("syntax errors show a message with the line number instead of a blank", async () => {
    const doc = "```mermaid\nflowchart TD\n  A --> BAD\n```\n\nend";
    const view = mount(doc);
    try {
      const err = await vi.waitFor(() => {
        const message = view.dom.querySelector<HTMLElement>(
          "[data-testid=diagram-error]",
        );
        expect(message).not.toBeNull();
        return message!;
      });
      expect(err.dataset.line).toBe("2");
      expect(err.textContent).toContain("第 2 行");
      expect(view.dom.querySelector(".k-diagram svg")).toBeNull();
      expect(mermaidMock.render).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("empty diagrams show an error, not a blank", async () => {
    const result = await renderDiagram("mermaid", "  ", readDiagramTheme());
    expect(result.svg).toBe("");
    expect(result.error).toBeTruthy();
  });

  it("caches by source + theme (LRU)", async () => {
    const t1 = readDiagramTheme();
    const t2 = theme({ bg: "#1C1A17" });
    await renderDiagram("mermaid", "flowchart TD\nA-->B", t1);
    await renderDiagram("mermaid", "flowchart TD\nA-->B", t1);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(
      getCachedDiagram("mermaid", "flowchart TD\nA-->B", t1)?.svg,
    ).toContain("<svg");
    await renderDiagram("mermaid", "flowchart TD\nA-->B", t2);
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);

    // LRU: touch the first entry, then overflow; the untouched one is evicted.
    for (let i = 0; i < MAX_DIAGRAM_CACHE_ENTRIES; i++) {
      if (i === 10) getCachedDiagram("mermaid", "flowchart TD\nA-->B", t1);
      await renderDiagram("mermaid", `flowchart TD\nN${i}`, t1);
    }
    expect(getDiagramCacheSize()).toBe(MAX_DIAGRAM_CACHE_ENTRIES);
    expect(
      getCachedDiagram("mermaid", "flowchart TD\nA-->B", t1),
    ).toBeDefined();
    expect(
      getCachedDiagram("mermaid", "flowchart TD\nA-->B", t2),
    ).toBeUndefined();
  });

  it("flow / sequence errors map back to the source line", async () => {
    const t = readDiagramTheme();
    const flow = await renderDiagram("flow", "a=>start: A\nb=>bogus: B", t);
    expect(flow.line).toBe(2);
    const seq = await renderDiagram("sequence", "A->B: hi\nBAD->C: x", t);
    expect(seq.line).toBe(2);
  });
});

describe("source mode", () => {
  it("turning source mode on removes diagram widgets; off brings them back", async () => {
    const controller = createSourceModeController();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: FLOW_DOC,
        selection: EditorSelection.cursor(FLOW_DOC.length),
        extensions: [
          markdown({ base: markdownLanguage }),
          controller.extension,
        ],
      }),
      parent,
    });
    await settle();
    expect(view.dom.querySelector(".k-diagram")).not.toBeNull();
    controller.setSourceMode(view, true);
    expect(view.dom.querySelector(".k-diagram")).toBeNull();
    expect(view.state.field(diagramStateField, false)).toBeUndefined();
    controller.setSourceMode(view, false);
    expect(view.dom.querySelector(".k-diagram")).not.toBeNull();
    view.destroy();
  });
});

describe("translations", () => {
  it("flowchart.js -> Mermaid flowchart", () => {
    const src = [
      "st=>start: 開始",
      "op=>operation: 處理",
      "cond=>condition: 是否?",
      "e=>end: 結束",
      "",
      "st->op->cond",
      "cond(yes)->e",
      "cond(no)->op",
    ].join("\n");
    const out = flowToMermaid(src).split("\n");
    expect(out[0]).toBe("flowchart TD");
    expect(out[1]).toBe('f0(["開始"])');
    expect(out[3]).toBe('f2{"是否?"}');
    expect(out[6]).toBe("f0 --> f1 --> f2");
    expect(out[7]).toBe("f2 -->|yes| f3");
    expect(out[8]).toBe("f2 -->|no| f1");
  });

  it("flowchart.js undefined node reports its line", () => {
    expect(() => flowToMermaid("a=>start: A\na->zz")).toThrowError(/zz/);
  });

  it("js-sequence-diagrams -> Mermaid sequenceDiagram", () => {
    const src = "Title: 範例\nA->B: 你好\nB-->A: 回覆\nNote right of B: 想一下";
    expect(sequenceToMermaid(src).split("\n")).toEqual([
      "sequenceDiagram",
      "title 範例",
      "A->>B: 你好",
      "B-->>A: 回覆",
      "Note right of B: 想一下",
    ]);
    expect(() => sequenceToMermaid("A->B: ok\n???")).toThrowError(/序列圖/);
  });

  it("mermaid config never allows directives to lower security", () => {
    const cfg = mermaidConfig(readDiagramTheme());
    expect(cfg.secure).toEqual(
      expect.arrayContaining(["securityLevel", "htmlLabels"]),
    );
    expect(cfg.theme).toBe("base");
  });
});
