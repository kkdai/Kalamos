import { toNativePath } from "../platform";

/** EX-01 helpers shared by the app shell (src/main.ts). */

export const EXPORTING_PDF_MESSAGE = "匯出中…";
export const UNTITLED_DOCUMENT_NAME = "未命名";

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Document name without its Markdown extension ("未命名" when untitled). */
export function documentTitle(docPath: string | null): string {
  if (!docPath) return UNTITLED_DOCUMENT_NAME;
  const stem = basename(docPath).replace(/\.(md|markdown)$/i, "");
  return stem || UNTITLED_DOCUMENT_NAME;
}

/** Suggested save-dialog path: next to the document, same name, `.pdf`. */
export function defaultPdfPath(docPath: string | null): string {
  const name = `${documentTitle(docPath)}.pdf`;
  if (!docPath) return name;
  const idx = docPath.lastIndexOf("/");
  return idx > 0 ? `${docPath.slice(0, idx)}/${name}` : name;
}

/** Make sure the chosen path ends with `.pdf`. */
export function ensurePdfExtension(path: string): string {
  return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
}

export function exportedPdfMessage(path: string): string {
  return `已匯出 PDF：${toNativePath(path)}`;
}
