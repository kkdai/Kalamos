import "./front-matter-preview.css";

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";

type YamlModule = typeof import("yaml");

let yamlPromise: Promise<YamlModule> | null = null;
let loadedYaml: YamlModule | null = null;

/** Loads `yaml` (separate chunk) lazily the first time front matter is seen. */
export function loadYamlModule(): Promise<YamlModule> {
  if (!yamlPromise) {
    yamlPromise = import("yaml").then((m) => {
      loadedYaml = m;
      return m;
    });
    yamlPromise.catch(() => {
      yamlPromise = null;
    });
  }
  return yamlPromise;
}

/** The `yaml` module if already loaded (no loading triggered). */
export function getLoadedYamlModule(): YamlModule | null {
  return loadedYaml;
}

export type Fields = { entries: [string, MetadataValue][] };
export type MetadataValue = string | null | MetadataValue[] | Fields;

export function parseFields(
  source: string,
  yaml: YamlModule | null = loadedYaml,
): Fields | null {
  if (!yaml) return null;
  try {
    const { isAlias, isMap, isScalar, isSeq, parseDocument } = yaml;
    const doc = parseDocument(source, { prettyErrors: false });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) {
      return null;
    }

    let budget = 512;
    function read(node: unknown, depth: number): MetadataValue {
      if (--budget < 0 || depth > 10)
        throw new Error("Metadata preview is too large");
      if (node == null) return null;
      if (isScalar(node)) {
        if (typeof node.value === "string") return node.value;
        if (node.value === null && !node.source) return null;
        return node.source ?? String(node.value);
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

export function renderValue(doc: Document, value: MetadataValue): Node {
  if (value === null) return doc.createTextNode("—");
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
  pending: boolean;
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
    previous.editPosition === editPosition &&
    !(previous.pending && loadedYaml)
  ) {
    return previous;
  }
  if (!loadedYaml) {
    return {
      source,
      to: node.to,
      editPosition,
      fields: null,
      pending: true,
    };
  }
  const fields =
    previous && !previous.pending && previous.source === source
      ? previous.fields
      : parseFields(source, loadedYaml);
  return { source, to: node.to, editPosition, fields, pending: false };
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
const yamlLoadedEffect = StateEffect.define<null>();

export const frontMatterField = StateField.define<
  ReturnType<typeof previewState>
>({
  create(state) {
    const preview = readPreview(state, null);
    return previewState(preview, selectionInFrontMatter(state, preview));
  },
  update(value, tr) {
    const yamlLoaded = tr.effects.some((effect) => effect.is(yamlLoadedEffect));
    const preview =
      tr.docChanged ||
      yamlLoaded ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
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

/**
 * In preview mode, Backspace at the start of the line right after the closing
 * fence (`preview.to + 1`) — or inside the hidden range after a blur — enters
 * edit mode at the closing fence end instead of deleting the hidden newline.
 */
export function handleFrontMatterBackspace(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const fm = state.field(frontMatterField, false);
  if (!fm?.preview?.fields || fm.editing) return false;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const head = sel.main.head;
  if (head === 0 || head > fm.preview.to + 1) return false;
  view.dispatch({
    selection: { anchor: Math.min(head, fm.preview.to) },
    scrollIntoView: true,
  });
  return true;
}

/**
 * In preview mode, Delete while the cursor is still inside the hidden front
 * matter (`0..preview.to`) enters edit mode instead of deleting hidden content
 * or the newline after the closing fence.
 */
export function handleFrontMatterDelete(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const fm = state.field(frontMatterField, false);
  if (!fm?.preview?.fields || fm.editing) return false;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const head = sel.main.head;
  if (head > fm.preview.to) return false;
  view.dispatch({
    selection: { anchor: head === 0 ? fm.preview.editPosition : head },
    scrollIntoView: true,
  });
  return true;
}

const yamlLoaderPlugin = ViewPlugin.fromClass(
  class {
    private loading = false;
    private destroyed = false;

    constructor(readonly view: EditorView) {
      this.ensureLoaded();
    }

    update(): void {
      this.ensureLoaded();
    }

    destroy(): void {
      this.destroyed = true;
    }

    private ensureLoaded(): void {
      if (this.loading) return;
      const fm = this.view.state.field(frontMatterField, false);
      if (!fm?.preview?.pending) return;
      this.loading = true;
      void loadYamlModule()
        .then(() => {
          if (this.destroyed) return;
          if (!this.view.state.field(frontMatterField, false)?.preview?.pending)
            return;
          try {
            this.view.dispatch({ effects: yamlLoadedEffect.of(null) });
          } catch {
            // view destroyed meanwhile
          }
        })
        .catch(() => null)
        .finally(() => {
          this.loading = false;
        });
    }
  },
);

const frontMatterKeymap = Prec.high(
  keymap.of([
    {
      key: "Backspace",
      run: handleFrontMatterBackspace,
      shift: handleFrontMatterBackspace,
    },
    {
      key: "Mod-Backspace",
      mac: "Alt-Backspace",
      run: handleFrontMatterBackspace,
    },
    {
      mac: "Ctrl-h",
      run: handleFrontMatterBackspace,
    },
    {
      key: "Delete",
      run: handleFrontMatterDelete,
      shift: handleFrontMatterDelete,
    },
    {
      mac: "Ctrl-d",
      run: handleFrontMatterDelete,
    },
  ]),
);

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
  yamlLoaderPlugin,
  frontMatterKeymap,
  dismissOnOutsideClick,
  EditorView.focusChangeEffect.of((state, focused) =>
    !focused &&
    state.field(frontMatterField, false)?.editing &&
    (typeof document === "undefined" || document.hasFocus())
      ? leaveFrontMatter.of(null)
      : null,
  ),
];
