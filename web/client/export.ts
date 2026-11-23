import { buildExportHtml } from "../../src/export/html";
import type { PandocFormat } from "../../src/export/pandoc";
import { documentTitle } from "../../src/export/pdf";
import type { AssetInput } from "../shared/api";
import { assetUrl, json, request } from "./api";

export interface PdfExportOptions {
  mathAutoNumber?: boolean;
  imageRootDir?: string | null;
  /** Map a workspace path (without a leading slash) to a same-origin URL. */
  resolveAttachment?: (path: string) => string | null | Promise<string | null>;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function embedPdfImages(
  html: string,
  options: PdfExportOptions,
): Promise<string> {
  // Template contents are inert, unlike a document parsed by DOMParser (which
  // can load <img> URLs). Only fetch attachments, never Markdown's remote URLs.
  const template = document.createElement("template");
  template.innerHTML = html;
  const cache = new Map<string, Promise<string | null>>();
  const pending: Promise<void>[] = [];
  for (const image of template.content.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") ?? "";
    if (/^data:image\//i.test(src)) continue;
    const missing = () => {
      const label = document.createElement("span");
      label.className = "k-image-missing";
      label.textContent = `[${image.getAttribute("alt") || src}]`;
      image.replaceWith(label);
    };
    if (!src.startsWith("file:///")) {
      missing();
      continue;
    }
    let attached = cache.get(src);
    if (!attached) {
      attached = (async () => {
        const path = decodeURIComponent(new URL(src).pathname.slice(1));
        if (/[:\\\p{Cc}]/u.test(path)) return null;
        const address = await (options.resolveAttachment ?? assetUrl)(path);
        if (!address) return null;
        const url = new URL(address, location.href);
        if (url.origin !== location.origin || !/^https?:$/.test(url.protocol))
          return null;
        const response = await fetch(url, { redirect: "error" });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("image/")
        )
          return null;
        return dataUrl(await response.blob());
      })().catch(() => null);
      cache.set(src, attached);
    }
    pending.push(
      attached.then((data) => {
        if (data) image.setAttribute("src", data);
        else missing();
      }),
    );
  }
  await Promise.all(pending);
  // Template parsing preserves the elements, not the document wrappers.
  const head = [...template.content.children].filter((element) =>
    element.matches("meta, title, style"),
  );
  const metadata = head
    .map((element) => {
      element.remove();
      return element.outerHTML;
    })
    .join("");
  return `<!DOCTYPE html><html lang="zh-Hant"><head>${metadata}</head><body>${template.innerHTML}</body></html>`;
}

export async function pdfExport(
  content: string,
  path: string | null,
  options: PdfExportOptions = {},
): Promise<Blob> {
  const { html } = await buildExportHtml(content, {
    ...options,
    title: documentTitle(path),
    docPath: path ? `/${path.replace(/^\//, "")}` : null,
  });
  const offlineHtml = await embedPdfImages(html, options);
  return (await request("convert/pdf", "POST", { html: offlineHtml })).blob();
}

export async function pandocExport(
  format: PandocFormat,
  content: string,
  path: string | null,
): Promise<Blob> {
  return (
    await request("convert/export", "POST", { format, content, path })
  ).blob();
}

export async function pandocImport(
  file: File,
): Promise<{ content: string; attachments: AssetInput[] }> {
  const data = (await dataUrl(file)).split(",", 2)[1];
  return json("convert/import", "POST", { name: file.name, data });
}

/** Invoke only after the user explicitly chooses to upload this image. */
export async function uploadImage(path: string): Promise<string> {
  const { url } = await json<{ url: string }>("convert/upload", "POST", {
    path,
  });
  return url;
}

export { download as downloadExport } from "./api";
