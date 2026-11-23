import type { PoolClient } from "pg";
import type { SearchHit, SearchResults } from "../shared/search.ts";
import { HttpError, isObject, text } from "./input.ts";

const maxResults = 1000;

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export function searchOptions(params: URLSearchParams): SearchOptions {
  const query = text(params.get("q") ?? "", "Search");
  if (Buffer.byteLength(query) > 1024)
    throw new HttpError(400, "搜尋字串不可超過 1024 位元組。");
  return {
    query,
    caseSensitive: params.get("case") === "1",
    wholeWord: params.get("word") === "1",
    regex: params.get("regex") === "1",
  };
}

// regexp_instr reports code-point positions. Extra astral characters count
// twice in CodeMirror (UTF-16). C collation keeps this range in code-point order.
// Mark both ends of each match in one pass, then recover the original offsets
// by counting the lengths of the unmarked pieces. The marker is unbordered
// (cannot overlap itself). For a line that already contains it, use positions
// directly instead. The outer LIMIT stops after one extra eligible hit.
const findHits = String.raw`
  SELECT id, path, revision, line::int,
         lo + regexp_count(left(body, lo - 1) COLLATE "C", U&'[\+010000-\+10FFFF]') AS column,
         hi - lo + regexp_count(substr(body, lo, hi - lo) COLLATE "C", U&'[\+010000-\+10FFFF]') AS length,
         CASE WHEN lo > 41 THEN '…' ELSE '' END || ltrim(substr(body, greatest(lo - 40, 1), least(lo - 1, 40)), E' \t') AS before,
         substr(body, lo, least(hi - lo, 120)) AS match,
         CASE WHEN hi - lo > 120 THEN '…'
              ELSE rtrim(substr(body, hi, 120 - (hi - lo)), E' \t') ||
                   CASE WHEN substr(body, lo + 120, 1) <> '' THEN '…' ELSE '' END
         END AS after
  FROM (
    SELECT d.id, d.path, d.revision, l.line, l.body, hit.lo, hit.hi
    FROM (SELECT id, path, revision, content FROM documents WHERE NOT deleted ORDER BY path) d
    CROSS JOIN LATERAL (SELECT replace(d.content, E'\r\n', E'\n') AS normalized) n
    CROSS JOIN LATERAL string_to_table(
      CASE WHEN strpos(d.content, E'\r\n') > 0 AND strpos(replace(d.content, E'\r\n', ''), E'\n') = 0
           THEN n.normalized ELSE replace(n.normalized, E'\r', E'\n') END,
      E'\n'
    ) WITH ORDINALITY AS l(body, line)
    CROSS JOIN LATERAL (SELECT chr(1) || chr(2) AS marker) s
    CROSS JOIN LATERAL (
      WITH RECURSIVE fallback (lo, hi) AS (
        SELECT 0, 1 WHERE strpos(l.body, s.marker) > 0
        UNION ALL
        SELECT next.lo, next.hi
        FROM fallback m
        CROSS JOIN LATERAL (SELECT greatest(m.lo + 1, m.hi) AS pos) p
        CROSS JOIN LATERAL (
          SELECT regexp_instr(l.body, $1, p.pos, 1, 0, $2) AS lo,
                 regexp_instr(l.body, $1, p.pos, 1, 1, $2) AS hi
        ) next
        WHERE next.lo > 0
      )
      SELECT lo, hi FROM fallback WHERE lo > 0
      UNION ALL
      SELECT hi - size, hi FROM (
        SELECT ord, length(piece) AS size,
               (sum(length(piece)) OVER (ORDER BY ord ROWS UNBOUNDED PRECEDING) + 1)::int AS hi
        FROM string_to_table(
          CASE WHEN strpos(l.body, s.marker) = 0
               THEN regexp_replace(l.body, $1, s.marker || E'\\&' || s.marker, $2 || 'g') END,
          s.marker
        ) WITH ORDINALITY AS pieces(piece, ord)
      ) bounds
      WHERE ord % 2 = 0
    ) hit
    WHERE hi > lo AND (NOT $3 OR (
      NOT (lo > 1 AND substr(l.body, lo - 1, 1) ~ '^[[:alnum:]_]$'
        AND substr(l.body, lo, 1) ~ '^[[:alnum:]_]$')
      AND NOT (substr(l.body, hi - 1, 1) ~ '^[[:alnum:]_]$'
        AND substr(l.body, hi, 1) ~ '^[[:alnum:]_]$')
    ))
    LIMIT $4
  ) bounded
  ORDER BY path, line, lo
`;

export async function searchDocumentContents(
  db: PoolClient,
  options: SearchOptions,
): Promise<SearchResults> {
  if (!options.query) return { hits: [], truncated: false };
  const flags = `${options.caseSensitive ? "c" : "i"}${options.regex ? "" : "q"}`;
  // The caller runs this in its own transaction so the setting is not shared.
  await db.query("SET LOCAL statement_timeout = '1s'");
  try {
    // Validate even in an empty workspace or one with only empty documents.
    if (options.regex)
      await db.query("SELECT regexp_instr('', $1, 1, 1, 0, $2)", [
        options.query,
        flags,
      ]);
    const { rows } = await db.query<SearchHit>(findHits, [
      options.query,
      flags,
      options.wholeWord,
      maxResults + 1,
    ]);
    return {
      hits: rows.slice(0, maxResults),
      truncated: rows.length > maxResults,
    };
  } catch (error) {
    if (isObject(error)) {
      if (error.code === "2201B") throw new HttpError(422, "正規表示式無效");
      if (error.code === "57014")
        throw new HttpError(408, "搜尋逾時；請縮小搜尋範圍或簡化正規表示式。");
    }
    throw error;
  }
}
