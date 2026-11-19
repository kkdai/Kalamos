import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { localFileUrl } from "../ipc";
import { isSelectionTouchingRange } from "./live-preview";

export const UNSAVED_RELATIVE_IMAGE_HINT = "存檔後才能顯示相對路徑圖片";
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

// ---------------------------------------------------------------------------
// Document path (needed to resolve relative image paths)
// ---------------------------------------------------------------------------

export const setImageDocPathEffect = StateEffect.define<string | null>();

export const imageDocPathField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setImageDocPathEffect)) return effect.value;
    }
    return value;
  },
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export type ResolvedImageSrc =
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string }
  | { kind: "local"; path: string; url: string }
  | { kind: "needs-save" }
  | { kind: "invalid"; reason: string };

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%20/g, " ");
  }
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return "";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

/** Joins `base` (absolute folder) and `relative`, collapsing `.` and `..`. */
export function joinPath(base: string, relative: string): string {
  const parts = relative.startsWith("/")
    ? []
    : base.split("/").filter((p) => p.length > 0);
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return `/${parts.join("/")}`;
}

/** Strips `<...>` brackets and surrounding whitespace from a link destination. */
export function unwrapImageDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function resolveImageSrc(
  rawSrc: string,
  docPath: string | null,
  toUrl: (path: string) => string = localFileUrl,
): ResolvedImageSrc {
  const src = unwrapImageDestination(rawSrc);
  if (!src) return { kind: "invalid", reason: "empty" };

  if (/^https?:\/\//i.test(src)) {
    return { kind: "remote", url: src };
  }
  if (/^data:/i.test(src)) {
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(src)
      ? { kind: "data", url: src }
      : { kind: "invalid", reason: "data URL is not an image" };
  }

  let localPath: string;
  if (/^file:\/\//i.test(src)) {
    try {
      localPath = safeDecode(new URL(src).pathname);
    } catch {
      return { kind: "invalid", reason: "bad file URL" };
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return { kind: "invalid", reason: "unsupported scheme" };
  } else {
    const withoutSuffix = src.replace(/[?#].*$/, "");
    const decoded = safeDecode(withoutSuffix);
    if (decoded.startsWith("/")) {
      localPath = joinPath("/", decoded);
    } else {
      if (!docPath) return { kind: "needs-save" };
      localPath = joinPath(dirname(docPath), decoded);
    }
  }
  return { kind: "local", path: localPath, url: toUrl(localPath) };
}

// ---------------------------------------------------------------------------
// Parsing `![alt](src "title")`
// ---------------------------------------------------------------------------

export interface ImageSpec {
  from: number;
  to: number;
  alt: string;
  src: string;
  title: string | null;
}

function unquoteTitle(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "(" && last === ")")
    ) {
      return t.slice(1, -1);
    }
  }
  return t;
}

export function collectImageSpecs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[] = [
    { from: 0, to: state.doc.length },
  ],
): ImageSpec[] {
  const tree = syntaxTree(state);
  const specs: ImageSpec[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (nodeRef) => {
        if (nodeRef.name !== "Image") return;
        if (seen.has(nodeRef.from)) return false;
        seen.add(nodeRef.from);
        const node = nodeRef.node;
        const urlNode = node.getChild("URL");
        const marks = node.getChildren("LinkMark");
        if (!urlNode || marks.length < 2) return false;
        // Inline images never span lines in practice; skip anything odd.
        if (
          state.doc.lineAt(nodeRef.from).number !==
          state.doc.lineAt(nodeRef.to).number
        ) {
          return false;
        }
        const titleNode = node.getChild("LinkTitle");
        specs.push({
          from: nodeRef.from,
          to: nodeRef.to,
          alt: state.sliceDoc(marks[0].to, marks[1].from),
          src: state.sliceDoc(urlNode.from, urlNode.to),
          title: titleNode
            ? unquoteTitle(state.sliceDoc(titleNode.from, titleNode.to))
            : null,
        });
        return false;
      },
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function createBrokenImageIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("k-image-broken-icon");
  for (const d of [
    "M4 5h16v14H4z",
    "M4 15l4-4 3 3",
    "M14 12l2-2 4 4",
    "M15 4l-3 8 3 2-2 6",
  ]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function renderImageFallback(
  container: HTMLElement,
  alt: string,
  message: string,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  container.dataset.state = "error";
  const box = doc.createElement("span");
  box.className = "k-image-fallback";
  box.dataset.testid = "image-fallback";
  box.append(createBrokenImageIcon(doc));
  const text = doc.createElement("span");
  text.className = "k-image-fallback-text";
  text.textContent = alt ? `${alt} — ${message}` : message;
  box.append(text);
  container.append(box);
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly title: string | null,
    readonly resolved: ResolvedImageSrc,
  ) {
    super();
  }

  private key(): string {
    const r = this.resolved;
    if (r.kind === "invalid") return `invalid:${r.reason}`;
    if (r.kind === "needs-save") return "needs-save";
    return `${r.kind}:${r.url}`;
  }

  eq(other: ImageWidget): boolean {
    return (
      other.alt === this.alt &&
      other.title === this.title &&
      other.key() === this.key()
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const wrapper = doc.createElement("span");
    wrapper.className = "k-image";
    wrapper.dataset.testid = "image-widget";
    wrapper.setAttribute("contenteditable", "false");
    if (this.title) wrapper.title = this.title;

    const r = this.resolved;
    if (r.kind === "needs-save") {
      wrapper.dataset.state = "needs-save";
      const hint = doc.createElement("span");
      hint.className = "k-image-hint";
      hint.dataset.testid = "image-needs-save";
      hint.textContent = this.alt
        ? `${this.alt} — ${UNSAVED_RELATIVE_IMAGE_HINT}`
        : UNSAVED_RELATIVE_IMAGE_HINT;
      wrapper.append(hint);
    } else if (r.kind === "invalid") {
      renderImageFallback(wrapper, this.alt, "無法顯示圖片");
    } else {
      wrapper.dataset.state = "loading";
      const img = doc.createElement("img");
      img.className = "k-image-img";
      img.alt = this.alt;
      img.decoding = "async";
      img.loading = "lazy";
      img.draggable = false;
      if (this.title) img.title = this.title;
      img.addEventListener("load", () => {
        wrapper.dataset.state = "loaded";
        view.requestMeasure();
      });
      img.addEventListener("error", () => {
        renderImageFallback(wrapper, this.alt, "圖片載入失敗");
        view.requestMeasure();
      });
      img.src = r.url;
      wrapper.append(img);
    }

    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      let pos: number;
      try {
        pos = view.posAtDOM(wrapper);
      } catch {
        return;
      }
      // Put the cursor just after `![` so the source is revealed for editing.
      const anchor = Math.min(pos + 2, view.state.doc.length);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function buildImageDecorations(
  view: EditorView,
  toUrl: (path: string) => string = localFileUrl,
): DecorationSet {
  const state = view.state;
  const docPath = state.field(imageDocPathField, false) ?? null;
  const ranges =
    view.visibleRanges.length > 0 ? view.visibleRanges : [view.viewport];
  const decorations: Array<Range<Decoration>> = [];
  for (const spec of collectImageSpecs(state, ranges)) {
    if (isSelectionTouchingRange(state.selection, spec.from, spec.to)) continue;
    const widget = new ImageWidget(
      spec.alt,
      spec.title,
      resolveImageSrc(spec.src, docPath, toUrl),
    );
    decorations.push(
      Decoration.replace({ widget }).range(spec.from, spec.to),
    );
  }
  return Decoration.set(decorations, true);
}

function hasDocPathChange(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(setImageDocPathEffect)),
  );
}

export const imagePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildImageDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.view.composing) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        hasDocPathChange(update) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some((tr) => tr.reconfigured)
      ) {
        this.decorations = buildImageDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

// ---------------------------------------------------------------------------
// Insertion (drag & drop / paste)
// ---------------------------------------------------------------------------

export function isImageFilePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function imageExtFromMime(mime: string): string | null {
  return MIME_TO_EXT[mime.toLowerCase()] ?? null;
}

export interface ImageInsertion {
  from: number;
  insert: string;
  /** Cursor position after the inserted text. */
  cursor: number;
}

/**
 * Builds the text to insert `![](path)` lines at `pos`, one image per line.
 * Adds a line break before/after when `pos` is in the middle of a line.
 */
export function buildImageInsertion(
  state: EditorState,
  pos: number,
  relativePaths: readonly string[],
): ImageInsertion | null {
  if (relativePaths.length === 0) return null;
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(clamped);
  const sep = state.lineBreak;
  const body = relativePaths.map((p) => `![](${p})`).join(sep);
  const before = clamped > line.from ? sep : "";
  const after = clamped < line.to ? sep : "";
  const insert = `${before}${body}${after}`;
  return {
    from: clamped,
    insert,
    cursor: clamped + before.length + body.length,
  };
}

export function insertImageMarkdown(
  view: EditorView,
  pos: number,
  relativePaths: readonly string[],
): boolean {
  const insertion = buildImageInsertion(view.state, pos, relativePaths);
  if (!insertion) return false;
  view.dispatch({
    changes: { from: insertion.from, insert: insertion.insert },
    selection: { anchor: insertion.cursor },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  return true;
}

export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export type PasteImagesHandler = (
  files: File[],
  view: EditorView,
) => void | Promise<void>;

/** Intercepts pastes that carry image files and hands them to `handler`. */
export function imagePasteHandler(handler: PasteImagesHandler): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (!data) return false;
      const files: File[] = [];
      for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file && imageExtFromMime(file.type)) files.push(file);
      }
      if (files.length === 0) {
        for (const file of Array.from(data.files ?? [])) {
          if (imageExtFromMime(file.type)) files.push(file);
        }
      }
      if (files.length === 0) return false;
      event.preventDefault();
      void handler(files, view);
      return true;
    },
  });
}

export const imagePreviewExtension: Extension = [imagePreviewPlugin];
