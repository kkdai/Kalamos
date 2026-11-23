import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import "./front-matter-preview.css";

type Fields = { entries: [string, MetadataValue][] };
type MetadataValue = string | MetadataValue[] | Fields;

function parseFields(source: string): Fields | null {
  try {
    const doc = parseDocument(source, { prettyErrors: false });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents))
      return null;

    let budget = 512;
    function read(node: unknown, depth: number): MetadataValue {
      if (--budget < 0 || depth > 10)
        throw new Error("Metadata preview is too large");
      if (node == null) return "null";
      if (isScalar(node)) {
        return typeof node.value === "string"
          ? node.value
          : node.source || String(node.value);
      }
      // Do not expand aliases, which may be recursive or reference large values.
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

    const fields = read(doc.contents, 0) as Fields;
    return fields.entries.length ? fields : null;
  } catch {
    return null;
  }
}

function renderValue(value: MetadataValue): Node {
  if (typeof value === "string") return document.createTextNode(value || '""');
  if (Array.isArray(value)) {
    if (!value.length) return document.createTextNode("[]");
    const list = document.createElement("ul");
    for (const item of value) {
      const li = document.createElement("li");
      li.append(renderValue(item));
      list.append(li);
    }
    return list;
  }

  if (!value.entries.length) return document.createTextNode("{}");
  const fields = document.createElement("dl");
  for (const [key, item] of value.entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = key || '""';
    const description = document.createElement("dd");
    description.append(renderValue(item));
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

  eq(other: FrontMatterWidget) {
    return (
      this.fields === other.fields && this.editPosition === other.editPosition
    );
  }

  toDOM(view: EditorView) {
    const card = document.createElement("div");
    card.className = "front-matter-preview";
    card.dataset.testid = "front-matter-preview";
    const label = document.createElement("strong");
    label.className = "front-matter-preview-title";
    label.textContent = "文件資訊";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "front-matter-preview-edit";
    edit.setAttribute("aria-label", "編輯文件資訊");
    edit.addEventListener("click", () => {
      view.focus();
      view.dispatch({
        selection: { anchor: this.editPosition },
        scrollIntoView: true,
      });
    });
    card.append(label, renderValue(this.fields), edit);
    return card;
  }

  ignoreEvent() {
    return true;
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
  const editPosition = state.doc.lineAt(node.from).to + 1;
  const source = state.sliceDoc(editPosition, close.from);
  const fields =
    previous?.source === source ? previous.fields : parseFields(source);
  return { source, to: node.to, editPosition, fields };
}

function selectionInMetadata(state: EditorState, preview: Preview | null) {
  return (
    preview !== null &&
    state.selection.ranges.some(({ from, to }) => to > 0 && from <= preview.to)
  );
}

function decorate(preview: Preview | null, editing: boolean): DecorationSet {
  if (!preview?.fields || editing) return Decoration.none;
  return Decoration.set(
    Decoration.replace({
      block: true,
      widget: new FrontMatterWidget(preview.fields, preview.editPosition),
    }).range(0, preview.to),
  );
}

const leaveMetadata = StateEffect.define<null>();

export const frontMatterPreview = StateField.define<{
  preview: Preview | null;
  editing: boolean;
  decorations: DecorationSet;
}>({
  create(state) {
    const preview = readPreview(state, null);
    const editing = selectionInMetadata(state, preview);
    return { preview, editing, decorations: decorate(preview, editing) };
  },
  update(value, tr) {
    const preview =
      tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? readPreview(tr.state, value.preview)
        : value.preview;
    const editing = tr.effects.some((effect) => effect.is(leaveMetadata))
      ? false
      : tr.selection || tr.docChanged
        ? selectionInMetadata(tr.state, preview)
        : value.editing;
    if (preview === value.preview && editing === value.editing) return value;
    return { preview, editing, decorations: decorate(preview, editing) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.focusChangeEffect.of((_, focused) =>
      focused ? null : leaveMetadata.of(null),
    ),
  ],
});
