import type { IncomingMessage } from "node:http";
import type { PatchDocumentInput } from "../shared/api.ts";

const mebibyte = 1024 * 1024;
const maxAssetBytes = 10 * mebibyte;
export const maxJsonBytes = 32 * mebibyte;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const mime = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mime !== "application/json" ||
    request.headersDistinct["content-type"]?.length !== 1
  ) {
    throw new HttpError(415, "Use Content-Type: application/json.");
  }
  if (Number(request.headers["content-length"]) > maxJsonBytes) {
    throw new HttpError(413, "Request exceeds 32 MiB.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxJsonBytes)
      throw new HttpError(413, "Request exceeds 32 MiB.");
    chunks.push(chunk);
  }
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    throw new HttpError(400, "Request body must be valid UTF-8 JSON.");
  }
  if (!isObject(input))
    throw new HttpError(400, "Request body must be a JSON object.");
  return input;
}

export function workspacePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 1024 ||
    /[:\\\p{Cc}\p{Cs}]/u.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          !part.trim() ||
          Buffer.byteLength(part) > 255,
      )
  ) {
    throw new HttpError(
      400,
      "Use a relative workspace path with no empty, dot or parent segments.",
    );
  }
  return value;
}

export function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    /\p{Cs}/u.test(value)
  ) {
    throw new HttpError(
      400,
      `${name} must be a Unicode string without NUL characters.`,
    );
  }
  return value;
}

export function content(value: unknown): string {
  const str = text(value, "Content");
  if (Buffer.byteLength(str) > 8 * mebibyte)
    throw new HttpError(413, "Document exceeds 8 MiB.");
  return str;
}

export function patch(body: Record<string, unknown>): PatchDocumentInput {
  if (
    typeof body.revision !== "number" ||
    !Number.isInteger(body.revision) ||
    body.revision < 1 ||
    body.revision > 2_147_483_647
  ) {
    throw new HttpError(400, "A valid document revision is required.");
  }
  const update: PatchDocumentInput = { revision: body.revision };
  if ("path" in body) update.path = workspacePath(body.path);
  if ("content" in body) update.content = content(body.content);
  if ("deleted" in body) {
    if (typeof body.deleted !== "boolean")
      throw new HttpError(400, "Deleted must be a boolean.");
    update.deleted = body.deleted;
  }
  if (Object.keys(update).length === 1)
    throw new HttpError(400, "Supply a field to update.");
  return update;
}

export function base64(value: unknown, maxBytes = maxAssetBytes): Buffer {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length % 4 !== 0 ||
    /[^a-zA-Z0-9+/=]/.test(value)
  )
    throw new HttpError(400, "Data must be base64 without a data URL prefix.");
  if (value.length > 4 * Math.ceil(maxBytes / 3))
    throw new HttpError(413, "File exceeds the size limit.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new HttpError(400, "Data must be valid base64.");
  if (decoded.length > maxBytes)
    throw new HttpError(413, "File exceeds the size limit.");
  return decoded;
}

function matchesMime(mime: string, data: Buffer): boolean {
  const ascii = (start: number, end: number) =>
    data.toString("latin1", start, end);
  switch (mime) {
    case "image/png":
      return data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/avif":
      return ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12));
    case "image/bmp":
      return ascii(0, 2) === "BM";
    case "image/x-icon":
      return data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
    default:
      return false;
  }
}

export interface Asset {
  path: string;
  mime: string;
  data: Buffer;
}

export function asset(value: unknown): Asset {
  if (!isObject(value))
    throw new HttpError(400, "An attachment must be an object.");
  const path = workspacePath(value.path);
  const declaredMime =
    typeof value.mime === "string" ? value.mime.toLowerCase() : "";
  const mime =
    declaredMime === "image/vnd.microsoft.icon" ? "image/x-icon" : declaredMime;
  const data = base64(value.data);
  if (!matchesMime(mime, data)) {
    throw new HttpError(
      415,
      "Only matching PNG, JPEG, GIF, WebP, AVIF, BMP and ICO images are supported. SVG is not supported.",
    );
  }
  return { path, mime, data };
}

export function attachments(value: unknown): Asset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new HttpError(400, "Supply at most 100 attachments.");
  return value.map(asset);
}
