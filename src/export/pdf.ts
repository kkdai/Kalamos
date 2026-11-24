import { t } from "../i18n";
import { formatErrorMessage } from "../ipc";
import { toNativePath } from "../platform";

/** EX-01 helpers shared by the app shell (src/main.ts). */

export function exportingPdfMessage(): string {
  return t("export.exporting");
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Document name without its Markdown extension, or the UI's untitled label. */
export function documentTitle(docPath: string | null): string {
  return (
    (docPath && basename(docPath).replace(/\.(md|markdown)$/i, "")) ||
    t("export.untitled")
  );
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
  return t("export.pdf.done", { path: toNativePath(path) });
}

export function pdfErrorMessage(err: unknown): string {
  return formatErrorMessage(t("export.pdf.failed"), err);
}
