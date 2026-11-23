export interface DocumentSummary {
  id: string;
  path: string;
  revision: number;
  deleted: boolean;
  updatedAt: string;
}

export interface StoredDocument extends DocumentSummary {
  content: string;
}

export interface Attachment {
  path: string;
  mime: string;
  data: string;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    const message = details?.message ?? details?.error;
    throw new RequestError(
      response.status,
      typeof message === "string" ? message : `請求失敗（${response.status}）`,
    );
  }
  return response;
}

export async function json<T>(
  path: string,
  method?: string,
  body?: unknown,
): Promise<T> {
  return (await request(path, method, body)).json();
}

export function assetUrl(path: string): string {
  return `/api/assets?${new URLSearchParams({ path: path.replace(/^\//, "") })}`;
}

export async function readMarkdown(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new Error(`${file.name} 不是有效的 UTF-8 Markdown`, { cause: error });
  }
}

export function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = name;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
