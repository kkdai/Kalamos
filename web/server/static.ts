import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./input.ts";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export async function sendStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(404, "Not found.");
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid URL path.");
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.startsWith("."))
  ) {
    throw new HttpError(404, "Not found.");
  }
  const file = resolve(root, path === "/" ? "index.html" : `.${path}`);
  const mime = mimeTypes.get(extname(file));
  if (!file.startsWith(`${root}${sep}`) || !mime)
    throw new HttpError(404, "Not found.");

  const handle = await open(file, "r").catch(() => {
    throw new HttpError(
      404,
      path === "/"
        ? "Web build not found. Run npm run build:web or npm run dev:web."
        : "Not found.",
    );
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(404, "Not found.");
    response.setHeader("Content-Type", mime);
    response.setHeader("Content-Length", info.size);
    response.setHeader(
      "Content-Security-Policy",
      "base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    );
    if (request.method === "HEAD") response.end();
    else await pipeline(handle.createReadStream(), response);
  } finally {
    await handle.close();
  }
}
