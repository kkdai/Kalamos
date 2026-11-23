#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CARGO_VERSION_RE = /^(name = "kalamos"\r?\nversion = )"[^"\r\n]+"/m;

function formatJsonPath(keyPath) {
  return keyPath
    .map((key, index) => {
      if (key === "" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        return `[${JSON.stringify(key)}]`;
      }
      return index === 0 ? key : `.${key}`;
    })
    .join("");
}

/**
 * Locates the exact `[start, end]` character span of a JSON string value at
 * `keyPath` within an already-validated JSON document, without reformatting
 * any other part of the source text.
 */
function findJsonStringValueSpan(source, keyPath) {
  let pos = 0;
  const len = source.length;

  function skipWs() {
    while (pos < len) {
      const ch = source.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        pos += 1;
      } else {
        break;
      }
    }
  }

  function readString() {
    const start = pos;
    pos += 1; // opening '"'
    while (pos < len) {
      const ch = source.charCodeAt(pos);
      if (ch === 92) {
        pos += 2; // escaped character
      } else if (ch === 34) {
        pos += 1; // closing '"'
        return { start, end: pos, raw: source.slice(start, pos) };
      } else {
        pos += 1;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function skipValue() {
    skipWs();
    const ch = source[pos];
    if (ch === '"') {
      readString();
    } else if (ch === "{") {
      pos += 1;
      skipWs();
      if (source[pos] === "}") {
        pos += 1;
        return;
      }
      while (pos < len) {
        skipWs();
        readString();
        skipWs();
        pos += 1; // ':'
        skipValue();
        skipWs();
        if (source[pos] === ",") {
          pos += 1;
        } else {
          pos += 1; // '}'
          return;
        }
      }
    } else if (ch === "[") {
      pos += 1;
      skipWs();
      if (source[pos] === "]") {
        pos += 1;
        return;
      }
      while (pos < len) {
        skipValue();
        skipWs();
        if (source[pos] === ",") {
          pos += 1;
        } else {
          pos += 1; // ']'
          return;
        }
      }
    } else {
      while (pos < len) {
        const c = source[pos];
        if (
          c === " " ||
          c === "\t" ||
          c === "\n" ||
          c === "\r" ||
          c === "," ||
          c === "}" ||
          c === "]"
        ) {
          break;
        }
        pos += 1;
      }
    }
  }

  function locate(depth) {
    skipWs();
    if (depth === keyPath.length) {
      if (source[pos] !== '"') {
        return null;
      }
      const { start, end } = readString();
      return { start, end };
    }

    if (source[pos] !== "{") {
      return null;
    }
    pos += 1; // '{'
    skipWs();
    if (source[pos] === "}") {
      pos += 1;
      return null;
    }

    const targetKey = keyPath[depth];
    while (pos < len) {
      skipWs();
      const keyToken = readString();
      const keyName = JSON.parse(keyToken.raw);
      skipWs();
      pos += 1; // ':'
      if (keyName === targetKey) {
        return locate(depth + 1);
      }
      skipValue();
      skipWs();
      if (source[pos] === ",") {
        pos += 1;
      } else {
        pos += 1; // '}'
        return null;
      }
    }
    return null;
  }

  return locate(0);
}

function updateJsonVersionFields(filePath, relPath, keyPaths, version) {
  const source = readFileSync(filePath, "utf8");
  JSON.parse(source);

  const spans = keyPaths.map((keyPath) => {
    const span = findJsonStringValueSpan(source, keyPath);
    if (!span) {
      throw new Error(
        `Cannot find string version field "${formatJsonPath(keyPath)}" in ${relPath}`,
      );
    }
    return span;
  });

  spans.sort((a, b) => b.start - a.start);
  const encodedVersion = JSON.stringify(version);
  let updated = source;
  for (const { start, end } of spans) {
    updated = `${updated.slice(0, start)}${encodedVersion}${updated.slice(end)}`;
  }

  writeFileSync(filePath, updated, "utf8");
}

/**
 * Synchronizes the version in `package.json` across `package-lock.json`,
 * `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`
 * by replacing only the version string tokens in place.
 */
export function syncVersion(repoRoot = process.cwd()) {
  const { version } = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("Cannot find a valid version in package.json");
  }

  for (const relPath of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const filePath = resolve(repoRoot, relPath);
    const source = readFileSync(filePath, "utf8");
    if (!CARGO_VERSION_RE.test(source)) {
      throw new Error(`Cannot find the kalamos package version in ${relPath}`);
    }
    writeFileSync(
      filePath,
      source.replace(CARGO_VERSION_RE, (_, prefix) => `${prefix}"${version}"`),
      "utf8",
    );
  }

  updateJsonVersionFields(
    resolve(repoRoot, "package-lock.json"),
    "package-lock.json",
    [["version"], ["packages", "", "version"]],
    version,
  );

  updateJsonVersionFields(
    resolve(repoRoot, "src-tauri/tauri.conf.json"),
    "src-tauri/tauri.conf.json",
    [["version"]],
    version,
  );

  return version;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    syncVersion(process.cwd());
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
