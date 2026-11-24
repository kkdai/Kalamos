import "./front-matter-preview.css";

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

type Fields = { entries: [string, MetadataValue][] };
type MetadataValue = string | MetadataValue[] | Fields;

function parseFields(source: string): Fields | null {
  try {
    const doc = parseDocument(source, { prettyErrors: false });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) {
      return null;
    }

    let budget = 512;
    function read(node: unknown, depth: number): MetadataValue {
      if (--budget < 0 || depth > 10)
        throw new Error("Metadata preview is too large");
      if (node == null) return "null";
      if (isScalar(node)) {
        return typeof node.value === "string"
          ? node.value
          : (node.source ?? String(node.value));
      }
      // Keep aliases literal: expansion can be recursive or much larger than the source.
      if (isAlias(node)) return `*${node.source}`;
      if (isSeq(node)) return node.items.map((item) => read(item, depth + 1));
      if (isMap(node)) {
        return {
          entries: node.items.map(({ key, value }) => {
            if (!isScalar(key)) throw new Error("Expected a scalar key");
            return [String(key.value), read(value, depth + 1)];
          }),
        };
      }
      throw new Error("Unsupported YAML node");
    }

    return read(doc.contents, 0) as Fields;
  } catch {
    return null;
  }
}

function renderValue(doc: Document, value: MetadataValue): Node {
  if (typeof value === "string") return doc.createTextNode(value || '""');
  if (Array.isArray(value)) {
    if (!value.length) return doc.createTextNode("[]");
    const list = doc.createElement("ul");
    for (const item of value) {
      const li = doc.createElement("li");
      li.append(renderValue(doc, item));
      list.append(li);
    }
    return list;
  }
  if (!value.entries.length) return doc.createTextNode("{}");
  const fields = doc.createElement("dl");
  for (const [key, item] of value.entries) {
    const row = doc.createElement("div");
    const term = doc.createElement("dt");
    term.textContent = key || '""';
    const description = doc.createElement("dd");
    description.append(renderValue(doc, item));
    row.append(term, description);
    fields.append(row);
  }
  return fields;
}

class FrontMatterWidget extends WidgetType {
  constructor(
    readonly fields: Fields,
    readonly editPosition: number,
  ) {
    super();
  }

  eq(other: FrontMatterWidget): boolean {
    return (
      this.fields === other.fields && this.editPosition === other.editPosition
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const card = doc.createElement("div");
    card.className = "k-frontmatter-preview";
    card.dataset.testid = "front-matter-preview";
    const label = doc.createElement("strong");
    label.textContent = "文件資訊";
    const edit = doc.createElement("button");
    edit.type = "button";
    edit.className = "k-frontmatter-edit";
    edit.setAttribute("aria-label", "編輯文件資訊");
    edit.addEventListener("click", () => {
      view.focus();
      view.dispatch({
        selection: { anchor: this.editPosition },
        scrollIntoView: true,
      });
    });
    card.append(label, renderValue(doc, this.fields), edit);
    return card;
  }
}

type Preview = {
  source: string;
  to: number;
  editPosition: number;
  fields: Fields | null;
};

function readPreview(
  state: EditorState,
  previous: Preview | null,
): Preview | null {
  const node = syntaxTree(state).topNode.firstChild;
  if (node?.name !== "FrontMatter" || node.to > 64 * 1024) return null;
  const close = node.lastChild;
  if (!close || close.from === node.from) return null;
  const editPosition = state.doc.line(2).from;
  const source = state.sliceDoc(editPosition, close.from);
  if (
    previous?.source === source &&
    previous.to === node.to &&
    previous.editPosition === editPosition
  ) {
    return previous;
  }
  const fields =
    previous?.source === source ? previous.fields : parseFields(source);
  return { source, to: node.to, editPosition, fields };
}

function selectionInFrontMatter(
  state: EditorState,
  preview: Preview | null,
  editing = false,
): boolean {
  return (
    !!preview &&
    state.selection.ranges.some(
      ({ from, to }) => (editing || to > 0) && from <= preview.to,
    )
  );
}

function previewState(preview: Preview | null, editing: boolean) {
  const decorations =
    preview?.fields && !editing
      ? Decoration.set(
          Decoration.replace({
            block: true,
            widget: new FrontMatterWidget(preview.fields, preview.editPosition),
          }).range(0, preview.to),
        )
      : Decoration.none;
  return { preview, editing, decorations };
}

const leaveFrontMatter = StateEffect.define<null>();

const frontMatterField = StateField.define<ReturnType<typeof previewState>>({
  create(state) {
    const preview = readPreview(state, null);
    return previewState(preview, selectionInFrontMatter(state, preview));
  },
  update(value, tr) {
    const preview =
      tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? readPreview(tr.state, value.preview)
        : value.preview;
    const editing = tr.effects.some((effect) => effect.is(leaveFrontMatter))
      ? false
      : preview !== value.preview || tr.selection || tr.docChanged
        ? selectionInFrontMatter(tr.state, preview, value.editing)
        : value.editing;
    return preview === value.preview && editing === value.editing
      ? value
      : previewState(preview, editing);
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export function finishFrontMatterEdit(state: EditorState): EditorState {
  // The tab bar keeps editor focus, so switching sessions may not cause a blur.
  return state.field(frontMatterField, false)?.editing
    ? state.update({ effects: leaveFrontMatter.of(null) }).state
    : state;
}

const dismissOnOutsideClick = ViewPlugin.define((view) => {
  const doc = view.dom.ownerDocument;
  function onClick(event: MouseEvent) {
    if (!view.state.field(frontMatterField).editing) return;
    if (
      event.target instanceof Element &&
      view.contentDOM.contains(event.target) &&
      event.target.closest(".k-frontmatter-line")
    )
      return;
    view.dispatch({ effects: leaveFrontMatter.of(null) });
  }
  doc.addEventListener("click", onClick, true);
  return { destroy: () => doc.removeEventListener("click", onClick, true) };
});

export const frontMatterPreviewExtension = [
  frontMatterField,
  dismissOnOutsideClick,
  EditorView.focusChangeEffect.of((state, focused) =>
    !focused && state.field(frontMatterField).editing
      ? leaveFrontMatter.of(null)
      : null,
  ),
];
