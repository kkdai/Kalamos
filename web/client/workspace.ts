import type { DocSession, KalamosEditor } from "../../src/editor";
import {
  type Attachment,
  json,
  RequestError,
  type StoredDocument,
} from "./api";

export interface OpenDocument {
  record: StoredDocument;
  session: DocSession;
  timer?: number;
  scrollTop: number;
  queue: Promise<void>;
  recoveredDraft?: { key: string; snapshot: string };
}

interface Draft {
  content: string;
  revision: number;
  modifiedAt: number;
}

const writer = crypto.randomUUID();
const draftPrefix = (id: string) => `kalamos-web-draft:${id}`;
const ownDraftKey = (id: string) => `${draftPrefix(id)}:${writer}`;

export function readDraft(
  record: StoredDocument,
): (Draft & { key: string; snapshot: string }) | null {
  const prefix = draftPrefix(record.id);
  let newest: (Draft & { key: string; snapshot: string }) | null = null;
  try {
    const keys = Object.keys(localStorage).filter(
      (key) => key === prefix || key.startsWith(`${prefix}:`),
    );
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw);
        if (
          typeof entry?.content !== "string" ||
          !Number.isInteger(entry.revision)
        )
          continue;
        if (entry.content === record.content) {
          discardDraft(key, raw);
          continue;
        }
        const modifiedAt =
          typeof entry.modifiedAt === "number" ? entry.modifiedAt : 0;
        if (!newest || modifiedAt > newest.modifiedAt) {
          newest = {
            key,
            snapshot: raw,
            content: entry.content,
            revision: entry.revision,
            modifiedAt,
          };
        }
      } catch {
        // A malformed entry must not hide another tab's valid draft.
      }
    }
  } catch {
    // Browser recovery storage is optional.
  }
  return newest;
}

export function discardDraft(key: string, snapshot?: string) {
  try {
    if (snapshot === undefined || localStorage.getItem(key) === snapshot)
      localStorage.removeItem(key);
  } catch {
    // Browser recovery storage is optional; PostgreSQL remains authoritative.
  }
}

export function persistDraft(doc: OpenDocument, editor: KalamosEditor) {
  const own = ownDraftKey(doc.record.id);
  if (!editor.isSessionDirty(doc.session)) {
    discardDraft(own);
    if (doc.recoveredDraft)
      discardDraft(doc.recoveredDraft.key, doc.recoveredDraft.snapshot);
    doc.recoveredDraft = undefined;
    return true;
  }
  try {
    localStorage.setItem(
      own,
      JSON.stringify({
        revision: doc.record.revision,
        content: editor.getSessionContent(doc.session),
        modifiedAt: Date.now(),
      } satisfies Draft),
    );
    if (doc.recoveredDraft && doc.recoveredDraft.key !== own) {
      discardDraft(doc.recoveredDraft.key, doc.recoveredDraft.snapshot);
      doc.recoveredDraft = undefined;
    }
    return true;
  } catch {
    return false;
  }
}

export function createDocument(
  path: string,
  content: string,
  attachments: Attachment[] = [],
) {
  return json<StoredDocument>("documents", "POST", {
    path,
    content,
    attachments,
  });
}

export function readDocument(id: string) {
  return json<StoredDocument>(`documents/${id}`);
}

export function updateDocument(
  doc: OpenDocument,
  patch: () => Partial<Pick<StoredDocument, "content" | "path" | "deleted">>,
  editor: KalamosEditor,
  onCommitted?: (record: StoredDocument) => void,
) {
  const update = doc.queue.then(async () => {
    const diff = patch();
    if (!Object.keys(diff).length) return;
    try {
      const record = await json<StoredDocument>(
        `documents/${doc.record.id}`,
        "PATCH",
        {
          revision: doc.record.revision,
          ...diff,
        },
      );
      doc.record = record;
      onCommitted?.(record);
      if (diff.content !== undefined)
        editor.markSessionClean(doc.session, diff.content);
      persistDraft(doc, editor);
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status === 409 &&
        diff.content !== undefined
      ) {
        throw new Error(
          "版本不一致，未覆寫資料庫。可先下載目前內容，或將它存為新文件。",
          { cause: error },
        );
      }
      throw error;
    }
  });
  doc.queue = update.catch(() => {});
  return update;
}
