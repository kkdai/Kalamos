/**
 * IM-05: upload local images to an image host and replace their references
 * with the returned URLs.
 *
 * - Targets: the local images under the cursor / selection (`![]()` and
 *   `<img src>`); with none there, every local image in the document.
 *   Remote (`http(s)`) and `data:` images are never uploaded.
 * - Each reference's position is taken before the upload; edits made while
 *   uploading are tracked (a ChangeSet per upload) and positions remapped
 *   with `mapPos`. A reference that was edited meanwhile is skipped.
 * - All replacements go in one transaction (one undo step); only the
 *   destination changes, alt / title / other `<img>` attributes stay.
 */
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  ChangeSet,
  type EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  collectImageSpecs,
  effectiveImageRoot,
  imageDocPathField,
  type ImageSpec,
  resolveImageSrc,
} from "./images";
import { mapPosClamped } from "./positions";

export const NO_LOCAL_IMAGES_MESSAGE = "沒有可上傳的本機圖片";

export interface UploadTarget {
  /** Whole reference (`![…](…)` or `<img …>`). */
  from: number;
  to: number;
  /** Reference text when collected (to detect edits). */
  text: string;
  /** Destination (Markdown URL / `src` attribute value) inside the reference. */
  destFrom: number;
  destTo: number;
  /** Absolute local file path. */
  path: string;
  html: boolean;
}

/** Destination range of a Markdown image: its URL node. */
function markdownDestination(state: EditorState, spec: ImageSpec): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(spec.from + 1, 1);
  while (node.name !== "Image" && node.parent) node = node.parent;
  if (node.name !== "Image") return null;
  const url = node.getChild("URL");
  return url ? { from: url.from, to: url.to } : null;
}

/** Value range of the first `src` attribute of an `<img>` tag (first wins, as in HTML). */
export function imgSrcValueRange(tag: string): { from: number; to: number } | null {
  const re = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
  const m = re.exec(tag);
  if (!m) return null;
  const value = m[1] ?? m[2] ?? m[3] ?? "";
  const quoted = m[1] !== undefined || m[2] !== undefined;
  const end = m.index + m[0].length - (quoted ? 1 : 0);
  return { from: end - value.length, to: end };
}

function targetFor(state: EditorState, spec: ImageSpec): UploadTarget | null {
  const resolved = resolveImageSrc(
    spec.src,
    state.field(imageDocPathField, false) ?? null,
    (p) => p,
    effectiveImageRoot(state),
  );
  if (resolved.kind !== "local") return null;
  const text = state.sliceDoc(spec.from, spec.to);
  let dest: { from: number; to: number } | null;
  if (spec.html) {
    const r = imgSrcValueRange(text);
    dest = r ? { from: spec.from + r.from, to: spec.from + r.to } : null;
  } else {
    dest = markdownDestination(state, spec);
  }
  if (!dest) return null;
  return {
    from: spec.from,
    to: spec.to,
    text,
    destFrom: dest.from,
    destTo: dest.to,
    path: resolved.path,
    html: Boolean(spec.html),
  };
}

/** Local images in `[from, to]` (all of the document by default). */
export function collectUploadTargetsInRange(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): UploadTarget[] {
  return collectImageSpecs(state, [{ from, to }])
    .filter((s) => s.to >= from && s.from <= to)
    .map((s) => targetFor(state, s))
    .filter((t): t is UploadTarget => t !== null)
    .sort((a, b) => a.from - b.from);
}

/**
 * Images under the cursor / selection, or every local image in the document
 * when none is there.
 */
export function collectUploadTargets(state: EditorState): {
  targets: UploadTarget[];
  scope: "selection" | "document";
} {
  const all = collectUploadTargetsInRange(state);
  const selected = all.filter((t) =>
    state.selection.ranges.some((r) => t.from <= r.to && t.to >= r.from),
  );
  return selected.length > 0
    ? { targets: selected, scope: "selection" }
    : { targets: all, scope: "document" };
}

/** A URL as a Markdown destination (no spaces / parentheses / angle brackets). */
export function markdownDestinationFor(url: string): string {
  return url.replace(/[ ()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** A URL as an `<img src>` value (inside its existing quotes). */
export function htmlAttributeFor(url: string): string {
  return url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Tracking edits made while an upload is running
// ---------------------------------------------------------------------------

const startTracking = StateEffect.define<number>();
const stopTracking = StateEffect.define<number>();

export const uploadTrackerField = StateField.define<ReadonlyMap<number, ChangeSet>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<number, ChangeSet> | null = null;
    if (tr.docChanged && value.size > 0) {
      next = new Map();
      for (const [id, changes] of value) next.set(id, changes.compose(tr.changes));
    }
    for (const e of tr.effects) {
      if (e.is(startTracking)) {
        next ??= new Map(value);
        next.set(e.value, ChangeSet.empty(tr.state.doc.length));
      } else if (e.is(stopTracking)) {
        next ??= new Map(value);
        next.delete(e.value);
      }
    }
    return next ?? value;
  },
});

let nextTrackingId = 1;

function ensureTracker(view: EditorView): void {
  if (view.state.field(uploadTrackerField, false) === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of(uploadTrackerField) });
  }
}

/** Start recording document changes; returns an id for `endTracking`. */
export function beginTracking(view: EditorView): number {
  ensureTracker(view);
  const id = nextTrackingId++;
  view.dispatch({ effects: startTracking.of(id) });
  return id;
}

/** Stop recording and return the changes made since `beginTracking`. */
export function endTracking(view: EditorView, id: number): ChangeSet {
  const changes =
    view.state.field(uploadTrackerField, false)?.get(id) ?? ChangeSet.empty(view.state.doc.length);
  view.dispatch({ effects: stopTracking.of(id) });
  return changes;
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

/** Did `changes` modify anything strictly inside `[from, to]`? (Edits next to it are fine.) */
export function changedInside(changes: ChangeSet, from: number, to: number): boolean {
  let hit = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (hit) return;
    if (fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from) hit = true;
  });
  return hit;
}

export interface ReplaceOutcome {
  replaced: number;
  /** References that were edited (or removed) during the upload. */
  skipped: number;
}

/**
 * Replace every target's destination with its URL (`urls` by `path`) in one
 * transaction, after remapping positions through `changes`.
 */
export function replaceUploadedImages(
  view: EditorView,
  targets: readonly UploadTarget[],
  urls: ReadonlyMap<string, string>,
  changes: ChangeSet,
): ReplaceOutcome {
  const specs: Array<{ from: number; to: number; insert: string }> = [];
  let skipped = 0;
  for (const t of targets) {
    const url = urls.get(t.path);
    if (!url) {
      skipped++;
      continue;
    }
    if (!changes.empty && changedInside(changes, t.from, t.to)) {
      skipped++;
      continue;
    }
    const from = mapPosClamped(changes, t.from, 1);
    const to = mapPosClamped(changes, t.to, -1);
    if (view.state.sliceDoc(from, to) !== t.text) {
      skipped++;
      continue;
    }
    const delta = from - t.from;
    specs.push({
      from: t.destFrom + delta,
      to: t.destTo + delta,
      insert: t.html ? htmlAttributeFor(url) : markdownDestinationFor(url),
    });
  }
  if (specs.length > 0) {
    view.dispatch({
      changes: specs,
      userEvent: "input.upload",
      annotations: isolateHistory.of("full"),
    });
  }
  return { replaced: specs.length, skipped };
}

// ---------------------------------------------------------------------------
// Whole flow
// ---------------------------------------------------------------------------

export interface UploadFlowOptions {
  view: EditorView;
  /** Configured upload command (null / empty = not configured). */
  uploader: string | null | undefined;
  /** Uploads local paths, returns one URL per path. */
  upload: (paths: string[]) => Promise<{ urls: string[] }>;
  setStatus: (message: string, isError?: boolean) => void;
  /** Explicit targets (e.g. just-inserted images); default: selection or whole document. */
  targets?: UploadTarget[];
  notConfiguredMessage: string;
}

export interface UploadFlowResult {
  uploaded: number;
  replaced: number;
  skipped: number;
  error: string | null;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export async function uploadImagesInEditor(options: UploadFlowOptions): Promise<UploadFlowResult> {
  const { view, setStatus } = options;
  const none: UploadFlowResult = { uploaded: 0, replaced: 0, skipped: 0, error: null };
  const uploader = options.uploader?.trim();
  if (!uploader) {
    setStatus(options.notConfiguredMessage, true);
    return { ...none, error: options.notConfiguredMessage };
  }
  const targets = options.targets ?? collectUploadTargets(view.state).targets;
  if (targets.length === 0) {
    setStatus(NO_LOCAL_IMAGES_MESSAGE, false);
    return none;
  }
  // The same file referenced twice is uploaded once.
  const paths = [...new Set(targets.map((t) => t.path))];
  const tool = basename(uploader);
  setStatus(`將上傳 ${paths.length} 張圖片…（${tool}）`, false);

  const trackingId = beginTracking(view);
  const urls = new Map<string, string>();
  try {
    for (const [i, path] of paths.entries()) {
      setStatus(`上傳中… (${i + 1}/${paths.length})：${basename(path)}（${tool}）`, false);
      const result = await options.upload([path]);
      const url = result.urls[0];
      if (result.urls.length !== 1 || !url) {
        throw new Error(`上傳指令回傳 ${result.urls.length} 個網址，需要 1 個`);
      }
      urls.set(path, url);
    }
  } catch (err) {
    endTracking(view, trackingId);
    const message = `上傳失敗：${errorText(err)}`;
    setStatus(message, true);
    return { ...none, error: message };
  }
  const changes = endTracking(view, trackingId);
  const { replaced, skipped } = replaceUploadedImages(view, targets, urls, changes);
  setStatus(
    skipped > 0
      ? `已上傳 ${paths.length} 張圖片；${skipped} 處引用在上傳期間被修改，未替換`
      : `已上傳 ${paths.length} 張圖片`,
    false,
  );
  return { uploaded: paths.length, replaced, skipped, error: null };
}
