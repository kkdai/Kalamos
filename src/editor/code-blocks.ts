import "./code-blocks.css";

import {
  ensureSyntaxTree,
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { isSelectionTouchingRange } from "./live-preview";

export const codeLineNumbersFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});

/**
 * Low-saturation HighlightStyle for Papyros (light) derived exclusively
 * from Kalamos theme CSS variables.
 */
export const papyrosHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: "var(--k-syntax-keyword)",
    fontWeight: "600",
    class: "k-tok-keyword",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--k-syntax-string)",
    class: "k-tok-string",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--k-syntax-comment)",
    fontStyle: "italic",
    class: "k-tok-comment",
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null],
    color: "var(--k-syntax-number)",
    class: "k-tok-number",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.macroName,
    ],
    color: "var(--k-syntax-function)",
    class: "k-tok-function",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    color: "var(--k-syntax-type)",
    class: "k-tok-type",
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: "var(--k-syntax-operator)",
    class: "k-tok-operator",
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: "var(--k-syntax-property)",
    class: "k-tok-property",
  },
]);

/**
 * Low-saturation HighlightStyle for Melan (dark) derived exclusively
 * from Kalamos theme CSS variables.
 */
export const melanHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: "var(--k-syntax-keyword)",
    fontWeight: "600",
    class: "k-tok-keyword",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--k-syntax-string)",
    class: "k-tok-string",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--k-syntax-comment)",
    fontStyle: "italic",
    class: "k-tok-comment",
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null],
    color: "var(--k-syntax-number)",
    class: "k-tok-number",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.macroName,
    ],
    color: "var(--k-syntax-function)",
    class: "k-tok-function",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    color: "var(--k-syntax-type)",
    class: "k-tok-type",
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: "var(--k-syntax-operator)",
    class: "k-tok-operator",
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: "var(--k-syntax-property)",
    class: "k-tok-property",
  },
]);

export function resolveCodeLanguage(
  infoString: string,
): LanguageDescription | null {
  const token = infoString.trim().split(/\s+/)[0] ?? "";
  if (!token) return null;
  return LanguageDescription.matchLanguageName(languages, token, true);
}

export class CodeLangBadgeWidget extends WidgetType {
  constructor(
    readonly rawInfo: string,
    readonly displayLang: string,
  ) {
    super();
  }

  eq(other: CodeLangBadgeWidget): boolean {
    return (
      this.rawInfo === other.rawInfo && this.displayLang === other.displayLang
    );
  }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "k-code-lang-badge";
    badge.dataset.testid = "code-lang-badge";
    badge.dataset.lang = this.rawInfo;
    badge.textContent = this.displayLang;
    badge.setAttribute("aria-hidden", "true");
    return badge;
  }
}

export interface FencedCodeBlockInfo {
  from: number;
  to: number;
  startLineNumber: number;
  endLineNumber: number;
  hasClosingFence: boolean;
  infoString: string;
  languageName: string | null;
  active: boolean;
}

export function collectFencedCodeBlocks(
  state: EditorState,
  ranges?: readonly { from: number; to: number }[],
): FencedCodeBlockInfo[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const targetRanges = ranges ?? [{ from: 0, to: state.doc.length }];
  const blocks: FencedCodeBlockInfo[] = [];
  const seen = new Set<string>();

  for (const r of targetRanges) {
    if (r.from >= r.to) continue;
    tree.iterate({
      from: r.from,
      to: r.to,
      enter: (nodeRef) => {
        if (nodeRef.name !== "FencedCode") return;
        const key = `${nodeRef.from}:${nodeRef.to}`;
        if (seen.has(key)) return false;
        seen.add(key);

        const syntaxNode = nodeRef.node;
        const codeMarks = syntaxNode.getChildren("CodeMark");
        const codeInfoNode = syntaxNode.getChild("CodeInfo");
        const infoString = codeInfoNode
          ? state.sliceDoc(codeInfoNode.from, codeInfoNode.to).trim()
          : "";
        const matched = resolveCodeLanguage(infoString);

        const startLine = state.doc.lineAt(nodeRef.from);
        const endLine = state.doc.lineAt(nodeRef.to);
        const hasClosingFence =
          codeMarks.length >= 2 &&
          state.doc.lineAt(codeMarks[codeMarks.length - 1].from).number ===
            endLine.number &&
          endLine.number > startLine.number;

        const active = isSelectionTouchingRange(
          state.selection,
          startLine.from,
          endLine.to,
        );

        blocks.push({
          from: nodeRef.from,
          to: nodeRef.to,
          startLineNumber: startLine.number,
          endLineNumber: endLine.number,
          hasClosingFence,
          infoString,
          languageName: matched?.name ?? null,
          active,
        });
        return false;
      },
    });
  }

  return blocks;
}

export async function ensureCodeBlockLanguagesLoaded(
  state: EditorState,
  view?: EditorView,
): Promise<LanguageDescription[]> {
  const blocks = collectFencedCodeBlocks(state);
  const loaded: LanguageDescription[] = [];
  let newlyLoaded = false;

  for (const b of blocks) {
    if (!b.infoString) continue;
    const desc = resolveCodeLanguage(b.infoString);
    if (!desc) continue;
    if (!desc.support) {
      await desc.load();
      newlyLoaded = true;
    }
    loaded.push(desc);
  }

  if (newlyLoaded && view) {
    // Reparse with newly loaded language support
    ensureSyntaxTree(view.state, view.state.doc.length, 200);
    view.dispatch({});
  }

  return loaded;
}

export function buildCodeBlockDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const visibleRanges =
    view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: state.doc.length }];
  const blocks = collectFencedCodeBlocks(state, visibleRanges);
  const showLineNumbers = state.facet(codeLineNumbersFacet);
  const decorations: Array<Range<Decoration>> = [];

  for (const block of blocks) {
    const openLine = state.doc.line(block.startLineNumber);
    const closeLine = state.doc.line(block.endLineNumber);

    // 1. Opening fence line
    const openLineClasses = [
      "k-codeblock-line",
      "k-codeblock-fence",
      "k-codeblock-fence-open",
      block.active ? "k-codeblock-fence-active" : "k-codeblock-fence-hidden",
    ];
    if (
      !block.hasClosingFence &&
      block.startLineNumber === block.endLineNumber
    ) {
      openLineClasses.push("k-codeblock-fence-close");
    }

    decorations.push(
      Decoration.line({ class: openLineClasses.join(" ") }).range(
        openLine.from,
      ),
    );

    if (block.active) {
      if (openLine.to > openLine.from) {
        decorations.push(
          Decoration.mark({ class: "k-mark k-code-fence-mark" }).range(
            openLine.from,
            openLine.to,
          ),
        );
      }
    } else {
      if (openLine.to > openLine.from) {
        decorations.push(
          Decoration.mark({ class: "k-mark-hidden k-code-fence-hidden" }).range(
            openLine.from,
            openLine.to,
          ),
        );
      }
      if (block.infoString) {
        const token = block.infoString.split(/\s+/)[0];
        decorations.push(
          Decoration.widget({
            widget: new CodeLangBadgeWidget(token, token),
            side: 1,
          }).range(openLine.to),
        );
      }
    }

    // 2. Content lines inside the fenced block
    const firstContentLine = block.startLineNumber + 1;
    const lastContentLine = block.hasClosingFence
      ? block.endLineNumber - 1
      : block.endLineNumber;

    let lineCounter = 1;
    for (let lineNo = firstContentLine; lineNo <= lastContentLine; lineNo++) {
      const line = state.doc.line(lineNo);
      const isLastWithoutClosing =
        !block.hasClosingFence && lineNo === block.endLineNumber;
      const lineClasses = ["k-codeblock-line", "k-codeblock-content-line"];
      if (isLastWithoutClosing) {
        lineClasses.push("k-codeblock-fence-close");
      }
      if (showLineNumbers) {
        lineClasses.push("k-codeblock-line-numbered");
      }
      const attrs: Record<string, string> | undefined = showLineNumbers
        ? { "data-line-number": String(lineCounter) }
        : undefined;
      decorations.push(
        Decoration.line({
          class: lineClasses.join(" "),
          attributes: attrs,
        }).range(line.from),
      );
      lineCounter++;
    }

    // 3. Closing fence line (if present)
    if (block.hasClosingFence) {
      const closeLineClasses = [
        "k-codeblock-line",
        "k-codeblock-fence",
        "k-codeblock-fence-close",
        block.active ? "k-codeblock-fence-active" : "k-codeblock-fence-hidden",
      ];
      decorations.push(
        Decoration.line({ class: closeLineClasses.join(" ") }).range(
          closeLine.from,
        ),
      );
      if (closeLine.to > closeLine.from) {
        decorations.push(
          Decoration.mark({
            class: block.active
              ? "k-mark k-code-fence-mark"
              : "k-mark-hidden k-code-fence-hidden",
          }).range(closeLine.from, closeLine.to),
        );
      }
    }
  }

  return Decoration.set(decorations, true);
}

const pendingLangLoads = new Set<string>();

function triggerLazyLanguageLoads(view: EditorView): void {
  const blocks = collectFencedCodeBlocks(view.state);
  for (const b of blocks) {
    if (!b.infoString) continue;
    const desc = resolveCodeLanguage(b.infoString);
    if (!desc || desc.support || pendingLangLoads.has(desc.name)) continue;
    pendingLangLoads.add(desc.name);
    void desc
      .load()
      .then(() => {
        pendingLangLoads.delete(desc.name);
        view.dispatch({});
      })
      .catch(() => {
        pendingLangLoads.delete(desc.name);
      });
  }
}

export const codeBlocksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    isComposing = false;

    constructor(view: EditorView) {
      this.decorations = buildCodeBlockDecorations(view);
      triggerLazyLanguageLoads(view);
    }

    update(update: ViewUpdate): void {
      if (this.isComposing || update.view.composing) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }
        return;
      }

      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some((tr) => tr.reconfigured)
      ) {
        this.decorations = buildCodeBlockDecorations(update.view);
        if (update.docChanged) {
          triggerLazyLanguageLoads(update.view);
        }
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
    eventHandlers: {
      compositionstart() {
        this.isComposing = true;
      },
      compositionend(_event, view) {
        this.isComposing = false;
        this.decorations = buildCodeBlockDecorations(view);
      },
    },
  },
);

export const codeBlocksHighlightExtension: Extension = [
  syntaxHighlighting(papyrosHighlightStyle),
  syntaxHighlighting(melanHighlightStyle, { fallback: true }),
];

export const codeBlocksExtension: Extension = [
  codeBlocksHighlightExtension,
  codeBlocksPlugin,
];
