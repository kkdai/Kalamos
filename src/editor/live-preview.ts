import { syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  Facet,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../ipc";
import {
  BulletMarkerWidget,
  jumpToHeadingSlug,
  parseRelativeMarkdownLink,
  TaskCheckboxWidget,
} from "./lists";

export type RelativeLinkHandler = (
  relativePath: string,
  slug: string | null,
  view: EditorView,
) => void | Promise<void>;

export const relativeLinkHandlerFacet = Facet.define<RelativeLinkHandler>();

export interface DecorationSpec {
  from: number;
  to: number;
  className: string;
  widgetType?: "bullet" | "task";
  checked?: boolean;
}

const HEADING_LEVEL_BY_NODE: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

const INLINE_CLASS_BY_NODE: Record<
  string,
  { contentClass: string; markNodeName: string }
> = {
  StrongEmphasis: {
    contentClass: "k-strong",
    markNodeName: "EmphasisMark",
  },
  Emphasis: {
    contentClass: "k-em",
    markNodeName: "EmphasisMark",
  },
  InlineCode: {
    contentClass: "k-code",
    markNodeName: "CodeMark",
  },
  Strikethrough: {
    contentClass: "k-strike",
    markNodeName: "StrikethroughMark",
  },
};

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  try {
    const parsed = new URL(trimmed);
    return ALLOWED_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isSelectionTouchingRange(
  selection: EditorSelection,
  from: number,
  to: number,
): boolean {
  for (const range of selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

export function collectLivePreviewSpecsInRanges(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSpec[] {
  const tree = syntaxTree(state);
  const specs: DecorationSpec[] = [];
  const selection = state.selection;
  const seenNodes = new Set<string>();

  for (const range of ranges) {
    if (range.from >= range.to) continue;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (nodeRef) => {
        const { name, from, to } = nodeRef;
        if (from >= to) return;

        const headingLevel = HEADING_LEVEL_BY_NODE[name];
        const inlineInfo = INLINE_CLASS_BY_NODE[name];
        const isLink = name === "Link";
        const isListItem = name === "ListItem";
        if (
          headingLevel === undefined &&
          inlineInfo === undefined &&
          !isLink &&
          !isListItem
        ) {
          return;
        }

        const nodeKey = `${name}:${from}:${to}`;
        if (seenNodes.has(nodeKey)) return;
        seenNodes.add(nodeKey);

        if (isListItem) {
          const syntaxNode = nodeRef.node;
          const listMark = syntaxNode.getChild("ListMark");
          if (!listMark || listMark.from >= listMark.to) return;

          const line = state.doc.lineAt(listMark.from);
          const activeOnLine = isSelectionTouchingRange(
            selection,
            line.from,
            line.to,
          );
          const isOrdered = syntaxNode.parent?.name === "OrderedList";
          const taskNode = syntaxNode.getChild("Task");
          const taskMarker = taskNode?.getChild("TaskMarker") ?? null;

          if (activeOnLine) {
            specs.push({
              from: listMark.from,
              to: listMark.to,
              className: "k-mark k-list-marker",
            });
            if (taskMarker && taskMarker.from < taskMarker.to) {
              specs.push({
                from: taskMarker.from,
                to: taskMarker.to,
                className: "k-mark",
              });
            }
          } else {
            if (taskMarker && taskMarker.from < taskMarker.to) {
              specs.push({
                from: listMark.from,
                to: taskMarker.from,
                className: "k-mark-hidden",
              });
              const markerText = state.sliceDoc(
                taskMarker.from,
                taskMarker.to,
              );
              const checked = /^\[[xX]\]$/.test(markerText);
              specs.push({
                from: taskMarker.from,
                to: taskMarker.to,
                className: "k-task-checkbox",
                widgetType: "task",
                checked,
              });
            } else if (isOrdered) {
              specs.push({
                from: listMark.from,
                to: listMark.to,
                className: "k-list-marker",
              });
            } else {
              specs.push({
                from: listMark.from,
                to: listMark.to,
                className: "k-list-marker",
                widgetType: "bullet",
              });
            }
          }
          return;
        }

        if (headingLevel !== undefined) {
          const syntaxNode = nodeRef.node;
          const marks = syntaxNode.getChildren("HeaderMark");
          if (marks.length === 0) return;

          const openMark = marks[0];
          const closeMark = marks.length > 1 ? marks[marks.length - 1] : null;
          const active = isSelectionTouchingRange(selection, from, to);
          const markClass = active ? "k-mark" : "k-mark-hidden";

          // Include the single space (or spaces) right after the leading `#` marks
          let prefixEnd = openMark.to;
          const lineText = state.sliceDoc(openMark.to, to);
          let spaceLen = 0;
          while (
            spaceLen < lineText.length &&
            (lineText[spaceLen] === " " || lineText[spaceLen] === "\t")
          ) {
            spaceLen++;
          }
          prefixEnd += spaceLen;

          let contentEnd = to;
          let suffixStart = to;
          if (closeMark && closeMark.from > prefixEnd) {
            suffixStart = closeMark.from;
            while (
              suffixStart > prefixEnd &&
              (state.sliceDoc(suffixStart - 1, suffixStart) === " " ||
                state.sliceDoc(suffixStart - 1, suffixStart) === "\t")
            ) {
              suffixStart--;
            }
            contentEnd = suffixStart;
          }

          if (prefixEnd > from) {
            specs.push({ from, to: prefixEnd, className: markClass });
          }
          if (contentEnd > prefixEnd) {
            specs.push({
              from: prefixEnd,
              to: contentEnd,
              className: `k-h${headingLevel}`,
            });
          }
          if (closeMark && to > suffixStart) {
            specs.push({ from: suffixStart, to, className: markClass });
          }
          return;
        }

        if (inlineInfo !== undefined) {
          const syntaxNode = nodeRef.node;
          const marks = syntaxNode.getChildren(inlineInfo.markNodeName);
          if (marks.length < 2) return;

          const openMark = marks[0];
          const closeMark = marks[marks.length - 1];
          const active = isSelectionTouchingRange(selection, from, to);
          const markClass = active ? "k-mark" : "k-mark-hidden";

          if (openMark.to > openMark.from) {
            specs.push({
              from: openMark.from,
              to: openMark.to,
              className: markClass,
            });
          }
          if (closeMark.from > openMark.to) {
            specs.push({
              from: openMark.to,
              to: closeMark.from,
              className: inlineInfo.contentClass,
            });
          }
          if (closeMark.to > closeMark.from) {
            specs.push({
              from: closeMark.from,
              to: closeMark.to,
              className: markClass,
            });
          }
          return;
        }

        if (isLink) {
          const syntaxNode = nodeRef.node;
          const linkMarks = syntaxNode.getChildren("LinkMark");
          if (linkMarks.length < 2) return;

          const openBracket = linkMarks[0];
          const closeBracket = linkMarks[1];
          const active = isSelectionTouchingRange(selection, from, to);
          const markClass = active ? "k-mark" : "k-mark-hidden";

          if (openBracket.to > openBracket.from) {
            specs.push({
              from: openBracket.from,
              to: openBracket.to,
              className: markClass,
            });
          }
          if (closeBracket.from > openBracket.to) {
            specs.push({
              from: openBracket.to,
              to: closeBracket.from,
              className: "k-link",
            });
          }
          if (to > closeBracket.from) {
            specs.push({
              from: closeBracket.from,
              to,
              className: markClass,
            });
          }
        }
      },
    });
  }

  return specs;
}

export function collectLivePreviewSpecs(
  state: EditorState,
  from = 0,
  to: number = state.doc.length,
): DecorationSpec[] {
  return collectLivePreviewSpecsInRanges(state, [{ from, to }]);
}

export function buildLivePreviewDecorations(view: EditorView): DecorationSet {
  const visibleRanges =
    view.visibleRanges.length > 0 ? view.visibleRanges : [view.viewport];
  const specs = collectLivePreviewSpecsInRanges(view.state, visibleRanges);
  const ranges: Array<Range<Decoration>> = specs.map((spec) => {
    if (spec.widgetType === "bullet") {
      return Decoration.replace({
        widget: new BulletMarkerWidget(),
      }).range(spec.from, spec.to);
    }
    if (spec.widgetType === "task") {
      return Decoration.replace({
        widget: new TaskCheckboxWidget(Boolean(spec.checked)),
      }).range(spec.from, spec.to);
    }
    return Decoration.mark({ class: spec.className }).range(
      spec.from,
      spec.to,
    );
  });
  return Decoration.set(ranges, true);
}

export function findLinkUrlAtPos(
  state: EditorState,
  pos: number,
): string | null {
  const tree = syntaxTree(state);
  const sides: Array<-1 | 0 | 1> = [0, 1, -1];
  for (const side of sides) {
    let cur: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
      pos,
      side,
    );
    while (cur) {
      if (cur.name === "Link") {
        const urlNode = cur.getChild("URL");
        if (urlNode) {
          return state.sliceDoc(urlNode.from, urlNode.to);
        }
        return null;
      }
      cur = cur.parent;
    }
  }
  return null;
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    isComposing = false;

    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view);
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
        this.decorations = buildLivePreviewDecorations(update.view);
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
        this.decorations = buildLivePreviewDecorations(view);
        queueMicrotask(() => {
          if (!this.isComposing && !view.composing) {
            view.dispatch({});
          }
        });
      },
      click(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        let checkPos: number | null = null;
        if (event.clientX !== 0 || event.clientY !== 0) {
          checkPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        }
        if (
          checkPos === null &&
          event.target instanceof Node &&
          event.target !== view.contentDOM &&
          view.contentDOM.contains(event.target)
        ) {
          try {
            checkPos = view.posAtDOM(event.target);
          } catch {
            checkPos = null;
          }
        }
        const url = findLinkUrlAtPos(
          view.state,
          checkPos ?? view.state.selection.main.head,
        );
        if (!url) return false;

        // 1. Heading anchor `#slug`
        if (url.startsWith("#")) {
          event.preventDefault();
          jumpToHeadingSlug(view, url.slice(1));
          return true;
        }

        // 2. Relative `.md` / `.markdown` link (with optional `#slug`)
        const relativeTarget = parseRelativeMarkdownLink(url);
        if (relativeTarget) {
          event.preventDefault();
          const handler = view.state.facet(relativeLinkHandlerFacet)[0];
          if (handler) {
            void handler(
              relativeTarget.pathPart,
              relativeTarget.slugPart,
              view,
            );
          }
          return true;
        }

        // 3. External `http:` / `https:` / `mailto:` link
        if (!isAllowedExternalUrl(url)) return false;
        event.preventDefault();
        if (isTauri()) {
          void openUrl(url).catch(() => null);
        } else if (
          typeof window !== "undefined" &&
          typeof window.open === "function"
        ) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return true;
      },
    },
  },
);

export const livePreviewExtension = [livePreviewPlugin];
