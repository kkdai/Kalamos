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
}

interface Draft {
  content: string;
  revision: number;
}

const draftKey = (id: string) => `kalamos-web-draft:${id}`;

export function readDraft(id: string): Draft | null {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(id)) ?? "null");
    return typeof draft?.content === "string" &&
      Number.isInteger(draft.revision)
      ? { content: draft.content, revision: draft.revision }
      : null;
  } catch {
    return null;
  }
}

export function discardDraft(id: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    // Browser recovery storage is optional; PostgreSQL remains authoritative.
  }
}

export function persistDraft(doc: OpenDocument, editor: KalamosEditor) {
  if (!editor.isSessionDirty(doc.session)) {
    discardDraft(doc.record.id);
    return true;
  }
  try {
    localStorage.setItem(
      draftKey(doc.record.id),
      JSON.stringify({
        revision: doc.record.revision,
        content: editor.getSessionContent(doc.session),
      } satisfies Draft),
    );
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
