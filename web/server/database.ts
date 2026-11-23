import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import type {
  DocumentSummary,
  PatchDocumentInput,
  WorkspaceDocument,
} from "../shared/api.ts";
import { type Asset, HttpError, isObject } from "./input.ts";
import { type SearchOptions, searchDocumentContents } from "./search.ts";

const migrations = new URL("./migrations/", import.meta.url);
const summary = 'id, path, revision, deleted, updated_at AS "updatedAt"';
const document = `${summary}, content`;

type DatabaseRow<T> = Omit<T, "updatedAt"> & { updatedAt: Date };

function dated<T extends { updatedAt: Date }>({ updatedAt, ...row }: T) {
  return { ...row, updatedAt: updatedAt.toISOString() };
}

export function openDatabase(connectionString: string, options?: string): Pool {
  const pool = new Pool({
    connectionString,
    options,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  pool.on("error", () =>
    console.error("An idle PostgreSQL connection was lost."),
  );
  return pool;
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    // A client read timeout does not cancel SQL on PostgreSQL. Drop the
    // connection instead of queuing ROLLBACK behind the timed-out statement.
    destroy = error instanceof Error && error.message === "Query read timeout";
    if (!destroy) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroy = true;
      }
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const names = (await readdir(migrations))
    .filter((name) => /^\d+_\w+\.sql$/.test(name))
    .sort();
  await transaction(pool, async (client) => {
    // Serialize startup if two API processes point to the same PostgreSQL database.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [1694390534, 1]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)",
    );
    const applied = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations",
        )
      ).rows.map(({ name }) => name),
    );
    for (const name of names) {
      if (applied.has(name)) continue;
      await client.query(await readFile(new URL(name, migrations), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        name,
      ]);
    }
  });
}

async function query<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code =
      isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "23505")
      throw new HttpError(409, "A document already uses this path.");
    console.error(
      `PostgreSQL operation failed${/^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : ""}.`,
    );
    throw new HttpError(
      503,
      "Database unavailable. Check the PostgreSQL service and try again.",
    );
  }
}

async function insertAsset(db: PoolClient, asset: Asset): Promise<void> {
  const inserted = await db.query(
    "INSERT INTO assets (path, mime, data) VALUES ($1, $2, $3) ON CONFLICT (path) DO NOTHING",
    [asset.path, asset.mime, asset.data],
  );
  if (inserted.rowCount === 1) return;
  const { rows } = await db.query<{ identical: boolean }>(
    "SELECT mime = $2 AND data = $3 AS identical FROM assets WHERE path = $1",
    [asset.path, asset.mime, asset.data],
  );
  if (!rows[0]?.identical)
    throw new HttpError(409, "A different attachment already uses this path.");
}

export function workspace(pool: Pool) {
  // Commit only after the client receives the result of every SQL write. This
  // prevents a stalled statement from committing after an API read timeout.
  const write = <T>(work: (client: PoolClient) => Promise<T>) =>
    query(() => transaction(pool, work));
  return {
    health: () => query(() => pool.query("SELECT 1")),
    search: (options: SearchOptions) =>
      query(() =>
        transaction(pool, (client) => searchDocumentContents(client, options)),
      ),
    list: (trash: boolean, search: string) =>
      query(async () => {
        const { rows } = await pool.query<DatabaseRow<DocumentSummary>>(
          `SELECT ${summary} FROM documents WHERE deleted = $1 AND
        ($2 = '' OR strpos(lower(path), lower($2)) > 0 OR strpos(lower(content), lower($2)) > 0)
        ORDER BY path, id`,
          [trash, search],
        );
        return rows.map(dated);
      }),
    create: (path: string, content: string, attachments: Asset[]) =>
      write(async (client) => {
        const { rows } = await client.query<DatabaseRow<WorkspaceDocument>>(
          `INSERT INTO documents (id, path, content) VALUES ($1, $2, $3) RETURNING ${document}`,
          [randomUUID(), path, content],
        );
        // Take asset locks in the same order for concurrent imports.
        attachments.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        for (const attachment of attachments)
          await insertAsset(client, attachment);
        return dated(rows[0]);
      }),
    read: (id: string) =>
      query(async () => {
        const { rows } = await pool.query<DatabaseRow<WorkspaceDocument>>(
          `SELECT ${document} FROM documents WHERE id = $1`,
          [id],
        );
        if (!rows[0]) throw new HttpError(404, "Document not found.");
        return dated(rows[0]);
      }),
    patch: (
      id: string,
      { revision, path, content, deleted }: PatchDocumentInput,
    ) =>
      write(async (client) => {
        const { rows } = await client.query<DatabaseRow<WorkspaceDocument>>(
          `UPDATE documents SET path = COALESCE($3, path), content = COALESCE($4, content),
        deleted = COALESCE($5, deleted), revision = revision + 1, updated_at = clock_timestamp()
        WHERE id = $1 AND revision = $2 RETURNING ${document}`,
          [id, revision, path, content, deleted],
        );
        if (rows[0]) return dated(rows[0]);
        if (
          (await client.query("SELECT 1 FROM documents WHERE id = $1", [id]))
            .rows.length === 0
        ) {
          throw new HttpError(404, "Document not found.");
        }
        throw new HttpError(
          409,
          "The document changed. Reload it before saving.",
        );
      }),
    settings: () =>
      query(async () => {
        const { rows } = await pool.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM settings WHERE singleton = true",
        );
        return rows[0]?.data ?? {};
      }),
    saveSettings: (json: string) =>
      write(async (client) => {
        const { rows } = await client.query<{ data: Record<string, unknown> }>(
          "INSERT INTO settings (singleton, data) VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET data = excluded.data RETURNING data",
          [json],
        );
        return rows[0].data;
      }),
    asset: (path: string) =>
      query(async () => {
        const { rows } = await pool.query<Asset>(
          "SELECT path, mime, data FROM assets WHERE path = $1",
          [path],
        );
        return rows[0];
      }),
    writeAsset: (asset: Asset) => write((client) => insertAsset(client, asset)),
  };
}
