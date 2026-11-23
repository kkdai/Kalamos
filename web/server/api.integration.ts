import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as nodeRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { Pool } from "pg";
import type { WorkspaceDocument } from "../shared/api.ts";
import { migrate, openDatabase } from "./database.ts";
import { allowedHosts, createHttpServer } from "./http.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL to an isolated PostgreSQL test database first.",
  );

const image = {
  path: "notes/assets/例 #1.png",
  mime: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII=",
};
const source =
  "\uFEFF# 記事\r\nSearch Needle 100%\r\n![Image](assets/例%20%231.png)";

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listen(pool: Pool, staticRoot: string) {
  const hosts = allowedHosts(4173, "web:4173");
  const server = createHttpServer(pool, hosts, staticRoot);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const host = `127.0.0.1:${address.port}`;
  hosts.add(host);
  return { server, origin: `http://${host}` };
}

async function fetchJson<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  assert.equal(response.status, status, body);
  return JSON.parse(body);
}

test("local HTTP API on PostgreSQL", async (t) => {
  const schema = `api_test_${randomUUID().replaceAll("-", "")}`;
  const admin = openDatabase(testDatabaseUrl);
  t.after(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = `-c search_path=${schema}`;
  let pool = openDatabase(testDatabaseUrl, options);
  const root = await mkdtemp(join(tmpdir(), "kalamos-api-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Kalamos</title>",
  );
  let app: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    const isolation = await pool.query("SELECT current_schema() AS schema");
    assert.equal(
      isolation.rows[0].schema,
      schema,
      "Test database connection must use the isolated schema.",
    );
    await Promise.all([migrate(pool), migrate(pool)]);
    const { rows } = await pool.query("SELECT name FROM schema_migrations");
    assert.deepEqual(rows, [{ name: "001_workspace.sql" }]);
    app = await listen(pool, root);
    let origin = app.origin;
    const send = (
      path: string,
      method = "GET",
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const api = "/api/documents";
    const img = (path: string) =>
      `/api/assets?${new URLSearchParams({ path })}`;

    await t.test(
      "binds locally, restricts Host/Origin and checks JSON and response headers",
      async () => {
        assert.deepEqual(await fetchJson(await send("/api/health"), 200), {
          ok: true,
        });
        assert.equal(
          (
            await send("/api/health", "GET", undefined, {
              Origin: "http://foreign.test",
            })
          ).status,
          403,
        );
        assert.equal(
          (await send("/api/health", "GET", undefined, { Origin: "null" }))
            .status,
          403,
        );
        assert.equal(
          (
            await send("/api/health", "GET", undefined, {
              "Sec-Fetch-Site": "same-site",
            })
          ).status,
          403,
        );
        assert.equal(
          (await send("/api/health", "GET", undefined, { Origin: origin }))
            .status,
          200,
        );
        const customHost = (host: string, originHeader?: string) =>
          new Promise<number | undefined>((resolve, reject) => {
            const req = nodeRequest(
              `${origin}/api/health`,
              {
                headers: {
                  Host: host,
                  ...(originHeader ? { Origin: originHeader } : {}),
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          });
        assert.equal(await customHost("workspace.example"), 403);
        assert.equal(
          await customHost("localhost:5173", "http://localhost:5173"),
          200,
        );
        assert.equal(await customHost("web:4173"), 200);
        assert.equal(await customHost("localhost:5173", origin), 403);
        assert.equal(
          (
            await send(
              api,
              "POST",
              { path: "test.md", content: "" },
              { "Content-Type": "text/plain" },
            )
          ).status,
          415,
        );
        assert.equal((await send(api, "POST", [])).status, 400);
        assert.equal(
          (
            await fetch(`${origin}${api}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{",
            })
          ).status,
          400,
        );
        assert.equal((await send(api, "OPTIONS")).status, 405);
        const page = await send("/");
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<title>Kalamos<\/title>/);
        assert.equal(page.headers.get("x-content-type-options"), "nosniff");
        assert.equal(
          page.headers.get("cross-origin-resource-policy"),
          "same-origin",
        );
        assert.equal(page.headers.get("x-frame-options"), "DENY");
        assert.equal(page.headers.get("access-control-allow-origin"), null);
        assert.equal((await send("/", "HEAD")).status, 200);
        assert.equal((await send("/server/index.ts")).status, 404);
        assert.equal((await send("/files/%2e%2e%2findex.html")).status, 404);
      },
    );

    let document: WorkspaceDocument;
    await t.test(
      "preserves UTF-8/BOM/newlines, lists summaries, serves only passive workspace assets",
      async () => {
        document = await fetchJson(
          await send(api, "POST", {
            path: "notes/原文.md",
            content: source,
            attachments: [image],
          }),
          201,
        );
        assert.equal(document.revision, 1);
        assert.equal(document.content, source);
        assert.match(document.updatedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
        assert.deepEqual(
          await fetchJson(await send(`${api}/${document.id}`), 200),
          document,
        );
        const { content: _content, ...summary } = document;
        assert.deepEqual(await fetchJson(await send(`${api}?q=nEeDlE`), 200), [
          summary,
        ]);
        assert.deepEqual(await fetchJson(await send(`${api}?q=原`), 200), [
          summary,
        ]);
        assert.deepEqual(await fetchJson(await send(`${api}?q=%25`), 200), [
          summary,
        ]);
        assert.deepEqual(await fetchJson(await send(`${api}?q=_`), 200), []);
        const response = await send(img(image.path));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), image.mime);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.match(
          response.headers.get("content-security-policy") ?? "",
          /sandbox/,
        );
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          Buffer.from(image.data, "base64"),
        );
        assert.deepEqual(
          await fetchJson(await send("/api/assets", "POST", image), 201),
          { path: image.path },
        );
        for (const path of [
          "../escape.md",
          "notes/../escape.md",
          "notes//blank.md",
          "C:\\fakepath\\a.md",
          "/absolute.md",
          "https://host/file.md",
          "nul\0.md",
          "surrogate\ud800.md",
        ]) {
          assert.equal(
            (await send(api, "POST", { path, content: "" })).status,
            400,
            path,
          );
        }
        assert.equal((await send(img("../escape"))).status, 400);
        assert.equal((await send(img("notes/missing.png"))).status, 404);
        const svg = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        ).toString("base64");
        assert.equal(
          (
            await send("/api/assets", "POST", {
              ...image,
              data: svg,
              mime: "image/svg+xml",
            })
          ).status,
          415,
        );
        assert.equal(
          (await send("/api/assets", "POST", { ...image, data: svg })).status,
          415,
        );
        assert.equal(
          (await send("/api/assets", "POST", { ...image, data: "AA=A" }))
            .status,
          400,
        );
        assert.equal(
          (await send(api, "POST", { path: "notes/bad.md", content: "NUL\0" }))
            .status,
          400,
        );
        assert.equal(
          (
            await send(api, "POST", {
              path: "notes/too-big.md",
              content: "a".repeat(8 * 1024 * 1024 + 1),
            })
          ).status,
          413,
        );
      },
    );

    await t.test(
      "rolls back an import on asset collision or document conflict",
      async () => {
        assert(document);
        const newImage = { ...image, path: "a-do-not-persist.png" };
        const conflictingImage = {
          ...image,
          data: Buffer.concat([
            Buffer.from(image.data, "base64"),
            Buffer.from([1]),
          ]).toString("base64"),
        };
        assert.equal(
          (
            await send(api, "POST", {
              path: "atomic.md",
              content: "rollback marker",
              attachments: [newImage, conflictingImage],
            })
          ).status,
          409,
        );
        assert.deepEqual(
          await fetchJson(await send(`${api}?q=rollback`), 200),
          [],
        );
        assert.equal((await send(img(newImage.path))).status, 404);
        assert.equal(
          (
            await send(api, "POST", {
              path: document.path,
              content: "duplicate",
              attachments: [newImage],
            })
          ).status,
          409,
        );
        assert.equal((await send(img(newImage.path))).status, 404);
      },
    );

    await t.test(
      "one concurrent write wins, settings replace previous data, and trash persists on API restart",
      async () => {
        assert(document);
        const path = `${api}/${document.id}`;
        const responses = await Promise.all([
          send(path, "PATCH", { revision: 1, content: "First" }),
          send(path, "PATCH", { revision: 1, content: "Second" }),
        ]);
        assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
        assert.equal(
          (await send(path, "PATCH", { revision: 1, content: "Stale" })).status,
          409,
        );
        assert.equal(
          (
            await send(`${api}/b45922bc-ae8e-4e00-a7a6-c18e69086c23`, "PATCH", {
              revision: 1,
              content: "Missing",
            })
          ).status,
          404,
        );
        assert.equal(
          (await send(path, "PATCH", { revision: 1.2, content: "Invalid" }))
            .status,
          400,
        );
        const winning = await fetchJson<WorkspaceDocument>(
          await send(path),
          200,
        );
        const renamed = await fetchJson<WorkspaceDocument>(
          await send(path, "PATCH", {
            revision: winning.revision,
            path: "renamed.md",
          }),
          200,
        );
        assert.equal(renamed.revision, 3);
        assert.equal(renamed.path, "renamed.md");
        assert.equal(renamed.content, winning.content);
        const trashed = await fetchJson<WorkspaceDocument>(
          await send(path, "PATCH", {
            revision: renamed.revision,
            deleted: true,
          }),
          200,
        );
        assert(trashed.deleted);
        assert.deepEqual(await fetchJson(await send(api), 200), []);
        assert.deepEqual(await fetchJson(await send("/api/settings"), 200), {});
        await fetchJson(
          await send("/api/settings", "POST", { theme: "dark", stale: true }),
          200,
        );
        const settings = {
          theme: "light",
          editor: { font: "書寫", words: true },
          sample: "nul\0test",
        };
        await fetchJson(await send("/api/settings", "POST", settings), 200);

        assert(app);
        await close(app.server);
        app = undefined;
        await pool.end();
        pool = openDatabase(testDatabaseUrl, options);
        await migrate(pool);
        app = await listen(pool, root);
        origin = app.origin;
        assert.deepEqual(
          await fetchJson(await send("/api/settings"), 200),
          settings,
        );
        assert.equal((await send(img(image.path))).status, 200);
        assert.deepEqual(await fetchJson(await send(path), 200), trashed);
        const { content: _content, ...summary } = trashed;
        assert.deepEqual(await fetchJson(await send(`${api}?trash=1`), 200), [
          summary,
        ]);
        const replacement = await fetchJson<WorkspaceDocument>(
          await send(api, "POST", {
            path: trashed.path,
            content: "Replacement",
          }),
          201,
        );
        assert.equal(
          (
            await send(path, "PATCH", {
              revision: trashed.revision,
              deleted: false,
            })
          ).status,
          409,
        );
        await fetchJson(
          await send(`${api}/${replacement.id}`, "PATCH", {
            revision: 1,
            deleted: true,
          }),
          200,
        );
        const restored = await fetchJson<WorkspaceDocument>(
          await send(path, "PATCH", {
            revision: trashed.revision,
            deleted: false,
          }),
          200,
        );
        assert.equal(restored.deleted, false);
        assert.equal(restored.content, winning.content);
      },
    );

    await t.test(
      "reports database failures without disclosing PostgreSQL details and permits retry",
      async () => {
        assert(document);
        const path = `${api}/${document.id}`;
        const current = await fetchJson<WorkspaceDocument>(
          await send(path),
          200,
        );
        await pool.query(
          "ALTER TABLE documents RENAME TO unavailable_documents",
        );
        try {
          const failure = await send(path, "PATCH", {
            revision: current.revision,
            content: "Try again",
          });
          assert.deepEqual(await fetchJson(failure, 503), {
            error:
              "Database unavailable. Check the PostgreSQL service and try again.",
          });
        } finally {
          await pool.query(
            "ALTER TABLE unavailable_documents RENAME TO documents",
          );
        }
        assert.deepEqual(await fetchJson(await send(path), 200), current);
        const retried = await fetchJson<WorkspaceDocument>(
          await send(path, "PATCH", {
            revision: current.revision,
            content: "Try again",
          }),
          200,
        );
        assert.equal(retried.revision, current.revision + 1);
        assert.equal(retried.content, "Try again");
      },
    );

    await t.test(
      "a timed-out SQL write cannot commit after its lock is released",
      async () => {
        assert(document);
        const path = `${api}/${document.id}`;
        const current = await fetchJson<WorkspaceDocument>(
          await send(path),
          200,
        );
        const locked = await pool.connect();
        const shortTimeout = new Pool({
          connectionString: testDatabaseUrl,
          options,
          query_timeout: 250,
        });
        const transient = await listen(shortTimeout, root);
        try {
          await locked.query("BEGIN");
          await locked.query("LOCK TABLE documents IN ACCESS EXCLUSIVE MODE");
          const failure = await fetch(`${transient.origin}${path}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              revision: current.revision,
              content: "Must not persist",
            }),
          });
          assert.equal(failure.status, 503);
          await failure.text();
        } finally {
          await locked.query("ROLLBACK");
          locked.release();
          await close(transient.server);
          await shortTimeout.end();
        }
        assert.deepEqual(await fetchJson(await send(path), 200), current);
      },
    );

    await t.test(
      "conversion routes report validation errors without invoking tools",
      async () => {
        assert.equal((await send("/api/convert/pdf", "GET")).status, 405);
        assert.equal(
          (await send("/api/convert/pdf", "POST", { html: [] })).status,
          400,
        );
        assert.equal(
          (
            await send("/api/convert/export", "POST", {
              format: "unsupported",
              content: "Valid",
              path: "note.md",
            })
          ).status,
          415,
        );
        assert.equal(
          (
            await send("/api/convert/import", "POST", {
              name: "invalid.format",
              data: "YQ==",
            })
          ).status,
          415,
        );
        assert.equal(
          (await send("/api/convert/upload", "POST", { path: "../outside" }))
            .status,
          400,
        );
      },
    );
  } finally {
    if (app) await close(app.server);
    await pool.end();
  }
});
