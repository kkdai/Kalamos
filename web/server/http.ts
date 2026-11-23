import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createConversion } from "./conversion.ts";
import { workspace } from "./database.ts";
import {
  asset,
  attachments,
  content,
  HttpError,
  patch,
  readJson,
  text,
  workspacePath,
} from "./input.ts";
import { searchOptions } from "./search.ts";
import { sendStatic } from "./static.ts";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
const workspaceDocumentRoute =
  /^\/api\/documents\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

export function allowedHosts(port: number, extra = ""): Set<string> {
  const list = new Set(
    loopbackHosts.flatMap((host) => [host, `${host}:${port}`, `${host}:5173`]),
  );
  for (const entry of extra.split(",")) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (!/^(?:[a-z0-9][a-z0-9.-]*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(host)) {
      throw new Error(
        "KALAMOS_WEB_ALLOWED_HOSTS must contain exact host[:port] values.",
      );
    }
    try {
      new URL(`http://${host}`);
    } catch {
      throw new Error(
        "KALAMOS_WEB_ALLOWED_HOSTS contains an invalid host or port.",
      );
    }
    list.add(host);
  }
  return list;
}

function checkLocal(request: IncomingMessage, hosts: ReadonlySet<string>) {
  const host = request.headers.host?.toLowerCase();
  if (!host || request.headersDistinct.host?.length !== 1 || !hosts.has(host)) {
    throw new HttpError(403, "Host is not allowed.");
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    (request.headersDistinct.origin?.length !== 1 ||
      origin !== new URL(`http://${host}`).origin)
  ) {
    throw new HttpError(403, "Origin must match the local application.");
  }
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendBinary(
  response: ServerResponse,
  mime: string,
  data: Uint8Array,
  download = false,
) {
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (download) response.setHeader("Content-Disposition", "attachment");
  response.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": data.length,
  });
  response.end(data);
}

function allowMethods(
  request: IncomingMessage,
  response: ServerResponse,
  ...methods: string[]
) {
  if (methods.includes(request.method ?? "")) return;
  response.setHeader("Allow", methods.join(", "));
  throw new HttpError(405, "Method not allowed.");
}

export function createHttpServer(
  pool: Pool,
  hosts: ReadonlySet<string>,
  staticRoot = dist,
) {
  const db = workspace(pool);
  const conversion = createConversion((path) => db.asset(workspacePath(path)));

  async function handle(request: IncomingMessage, response: ServerResponse) {
    checkLocal(request, hosts);
    const target = request.url;
    if (
      !target?.startsWith("/") ||
      target.startsWith("//") ||
      target.includes("\\")
    ) {
      throw new HttpError(400, "Invalid request URL.");
    }
    const url = new URL(target, "http://localhost");
    switch (url.pathname) {
      case "/api/health": {
        allowMethods(request, response, "GET");
        await db.health();
        return sendJson(response, 200, { ok: true });
      }
      case "/api/search": {
        allowMethods(request, response, "GET");
        return sendJson(
          response,
          200,
          await db.search(searchOptions(url.searchParams)),
        );
      }
      case "/api/documents": {
        allowMethods(request, response, "GET", "POST");
        if (request.method === "GET") {
          const search = text(url.searchParams.get("q") ?? "", "Search");
          if (Buffer.byteLength(search) > 1024)
            throw new HttpError(400, "Search exceeds 1024 bytes.");
          return sendJson(
            response,
            200,
            await db.list(url.searchParams.get("trash") === "1", search),
          );
        }
        const body = await readJson(request);
        return sendJson(
          response,
          201,
          await db.create(
            workspacePath(body.path),
            content(body.content),
            attachments(body.attachments),
          ),
        );
      }
      case "/api/settings": {
        allowMethods(request, response, "GET", "POST");
        if (request.method === "GET")
          return sendJson(response, 200, await db.settings());
        const json = JSON.stringify(await readJson(request));
        if (Buffer.byteLength(json) > 256 * 1024)
          throw new HttpError(413, "Settings exceed 256 KiB.");
        return sendJson(response, 200, await db.saveSettings(json));
      }
      case "/api/assets": {
        allowMethods(request, response, "GET", "POST");
        if (request.method === "GET") {
          const image = await db.asset(
            workspacePath(url.searchParams.get("path")),
          );
          if (!image) throw new HttpError(404, "Attachment not found.");
          return sendBinary(response, image.mime, image.data);
        }
        const input = asset(await readJson(request));
        await db.writeAsset(input);
        return sendJson(response, 201, { path: input.path });
      }
      case "/api/convert/pdf": {
        allowMethods(request, response, "POST");
        const { html } = await readJson(request);
        return sendBinary(
          response,
          "application/pdf",
          await conversion.pdf(text(html, "HTML")),
          true,
        );
      }
      case "/api/convert/export": {
        allowMethods(request, response, "POST");
        const body = await readJson(request);
        const path = body.path == null ? null : workspacePath(body.path);
        return sendBinary(
          response,
          "application/octet-stream",
          await conversion.export(
            text(body.format, "Format"),
            content(body.content),
            path,
          ),
          true,
        );
      }
      case "/api/convert/import": {
        allowMethods(request, response, "POST");
        const { name, data } = await readJson(request);
        return sendJson(
          response,
          200,
          await conversion.import(workspacePath(name), text(data, "Data")),
        );
      }
      case "/api/convert/upload": {
        allowMethods(request, response, "POST");
        const { path } = await readJson(request);
        return sendJson(
          response,
          200,
          await conversion.upload(workspacePath(path)),
        );
      }
      default: {
        const id = workspaceDocumentRoute.exec(url.pathname)?.[1];
        if (id) {
          allowMethods(request, response, "GET", "PATCH");
          const result =
            request.method === "GET"
              ? await db.read(id)
              : await db.patch(id, patch(await readJson(request)));
          return sendJson(response, 200, result);
        }
        if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
          throw new HttpError(404, "Not found.");
        return sendStatic(request, response, staticRoot, url.pathname);
      }
    }
  }

  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      if (!request.complete) response.setHeader("Connection", "close");
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        console.error("Unexpected error while handling a web request.");
        sendJson(response, 500, { error: "Unexpected server error." });
      }
    });
  });
}
