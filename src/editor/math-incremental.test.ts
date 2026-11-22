import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clearMathRenderCache,
  ensureMathJaxLoaded,
  getMathRenderCacheSize,
  mathMarkdownExtension,
  mathRefreshEffect,
  mathStateField,
} from "./math";

// Regression tests for #31 BUG-7 (10k-line typing latency) and BUG-3
// (math preview re-rendering during IME composition).

function createState(doc: string, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({ base: markdownLanguage, extensions: [mathMarkdownExtension] }),
      mathStateField,
    ],
  });
}

interface DecoInfo {
  from: number;
  to: number;
  value: Decoration;
  tex: string | undefined;
}

function decos(state: EditorState): DecoInfo[] {
  const out: DecoInfo[] = [];
  state
    .field(mathStateField)
    .decorations.between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget as { tex?: string } | undefined;
      out.push({ from, to, value, tex: widget?.tex });
    });
  return out;
}

function widgetTexes(state: EditorState): string[] {
  return decos(state)
    .map((d) => d.tex)
    .filter((t): t is string => t !== undefined);
}

/** 700 inline formulas — more than the 500-entry render cache. */
function manyFormulasDoc(count = 700): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(`段落 ${i} 公式 $x_{${i}}$ 結束`);
  return parts.join("\n\n");
}

describe("math decorations are incremental (#31 BUG-7)", () => {
  beforeAll(async () => {
    await ensureMathJaxLoaded();
  });

  it("typing in one paragraph keeps (maps) every other formula's decoration and typesets nothing", () => {
    const doc = manyFormulasDoc();
    const state = createState(doc, 0);
    const before = decos(state);
    expect(before).toHaveLength(700);

    clearMathRenderCache();
    const tr = state.update({
      changes: { from: 2, insert: "abc" },
      selection: EditorSelection.cursor(5),
      userEvent: "input.type",
    });
    const after = decos(tr.state);
    expect(after).toHaveLength(700);
    // Formulas far from the edit keep the very same Decoration objects.
    for (let i = 1; i < 700; i++) {
      expect(after[i].value).toBe(before[i].value);
      expect(after[i].from).toBe(before[i].from + 3);
    }
    // Building decorations never typesets; only drawn widgets do (lazily).
    expect(getMathRenderCacheSize()).toBe(0);
  });

  it("moving the cursor only rebuilds the formulas it leaves and enters", () => {
    const doc = manyFormulasDoc(50);
    const f10 = doc.indexOf("$x_{10}$");
    const f40 = doc.indexOf("$x_{40}$");
    const state = createState(doc, f10 + 2);
    const before = decos(state);
    // Formula 10 is active: source marks instead of a widget.
    expect(widgetTexes(state)).not.toContain("x_{10}");

    const moved = state.update({
      selection: EditorSelection.cursor(f40 + 2),
    }).state;
    expect(widgetTexes(moved)).toContain("x_{10}");
    expect(widgetTexes(moved)).not.toContain("x_{40}");

    const after = decos(moved);
    const untouched = (list: DecoInfo[]) =>
      list.filter(
        (d) => d.tex !== undefined && d.tex !== "x_{10}" && d.tex !== "x_{40}",
      );
    const b = untouched(before);
    const a = untouched(after);
    expect(a).toHaveLength(b.length);
    a.forEach((d, i) => expect(d.value).toBe(b[i].value));
  });

  it("opening a new $$ block re-parses everything after it (full rebuild)", () => {
    const doc = "a $x$\n\nb $y$\n\nc $z$";
    const state = createState(doc, 0);
    expect(widgetTexes(state)).toEqual(["x", "y", "z"]);
    const next = state.update({
      changes: { from: 0, insert: "$$\n" },
      selection: EditorSelection.cursor(0),
    }).state;
    // The unterminated $$ swallows nothing that it should not, and the
    // decorations match a from-scratch build of the new document.
    expect(widgetTexes(next)).toEqual(
      widgetTexes(createState(next.doc.toString(), 0)),
    );
  });

  it("deleting a $$ fence also matches a full rebuild", () => {
    const doc = "$$\nE=mc^2\n$$\n\n文字 $q$\n\nend";
    const state = createState(doc, doc.length);
    expect(widgetTexes(state)).toEqual(["\nE=mc^2\n", "q"]);
    const closeFence = doc.indexOf("$$", 3);
    const next = state.update({
      changes: { from: closeFence, to: closeFence + 2 },
    }).state;
    expect(widgetTexes(next)).toEqual(
      widgetTexes(createState(next.doc.toString(), next.doc.length)),
    );
  });
});

describe("math preview is frozen during IME composition (#31 BUG-3)", () => {
  it("maps decorations while composing and re-renders once composition ends", () => {
    const doc = "$$\nx+\n$$\n\nend";
    const state = createState(doc, 5);
    const preview = () => decos(cur).find((d) => d.tex !== undefined);
    let cur = state;
    expect(preview()?.tex).toBe("\nx+\n");

    for (const [from, to, text] of [
      [5, 5, "y"],
      [5, 6, "yi"],
      [5, 7, "一"],
    ] as const) {
      cur = cur.update({
        changes: { from, to, insert: text },
        selection: EditorSelection.cursor(from + text.length),
        userEvent: "input.type.compose",
      }).state;
      expect(preview()?.tex).toBe("\nx+\n");
    }
    expect(cur.doc.toString()).toBe("$$\nx+一\n$$\n\nend");

    cur = cur.update({ effects: mathRefreshEffect.of(null) }).state;
    expect(preview()?.tex).toBe("\nx+一\n");
  });

  it("the next normal transaction also flushes edits made during composition", () => {
    let cur = createState("段落 $a$ 尾", 5);
    cur = cur.update({
      changes: { from: 5, insert: "b" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type.compose",
    }).state;
    expect(cur.doc.toString()).toBe("段落 $ab$ 尾");
    cur = cur.update({
      selection: EditorSelection.cursor(cur.doc.length),
    }).state;
    expect(widgetTexes(cur)).toEqual(["ab"]);
  });
});
