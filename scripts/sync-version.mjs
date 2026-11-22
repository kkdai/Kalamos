#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CARGO_VERSION_RE = /^(name = "kalamos"\r?\nversion = )"[^"\r\n]+"/m;

function updateJson(path, update) {
  const source = readFileSync(path, "utf8");
  const data = JSON.parse(source);
  const indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? 2;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  update(data);
  const serialized = JSON.stringify(data, null, indent).replace(/\n/g, eol);
  writeFileSync(path, `${serialized}${eol}`, "utf8");
}

/**
 * Synchronizes the version in `package.json` across `package-lock.json`,
 * `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`.
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
      source.replace(CARGO_VERSION_RE, `$1"${version}"`),
      "utf8",
    );
  }

  updateJson(resolve(repoRoot, "package-lock.json"), (lock) => {
    lock.version = version;
    if (lock.packages?.[""]) {
      lock.packages[""].version = version;
    }
  });

  updateJson(resolve(repoRoot, "src-tauri/tauri.conf.json"), (config) => {
    config.version = version;
  });

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
