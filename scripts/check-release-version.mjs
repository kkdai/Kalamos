#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Extracts `version` from the `[package]` section of a Cargo.toml string.
 * Ignores `version` keys in other sections such as `[dependencies]`.
 */
export function extractCargoVersion(tomlContent) {
  let inPackageSection = false;
  for (const rawLine of tomlContent.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      inPackageSection = line === "[package]";
      continue;
    }

    if (inPackageSection) {
      const match = line.match(/^version\s*=\s*"([^"]+)"$/);
      if (match) {
        return match[1];
      }
    }
  }
  throw new Error("Could not find [package].version in src-tauri/Cargo.toml");
}

/**
 * Strips an optional `refs/tags/` prefix from a Git tag or ref string.
 */
export function normalizeTag(rawTag) {
  if (rawTag == null) return "";
  return String(rawTag)
    .trim()
    .replace(/^refs\/tags\//, "");
}

/**
 * Validates that package.json, tauri.conf.json, Cargo.toml, and (when given)
 * the Git release tag all agree on the exact same SemVer version.
 */
export function validateReleaseVersions({
  packageVersion,
  tauriVersion,
  cargoVersion,
  tag = "",
}) {
  const entries = [
    ["package.json", packageVersion],
    ["src-tauri/tauri.conf.json", tauriVersion],
    ["src-tauri/Cargo.toml", cargoVersion],
  ];

  for (const [label, value] of entries) {
    if (typeof value !== "string" || !SEMVER_RE.test(value)) {
      throw new Error(
        `Invalid or missing SemVer version in ${label}: ${JSON.stringify(value)}`,
      );
    }
  }

  if (packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
    throw new Error(
      [
        "Version mismatch across project manifests:",
        `  package.json:              ${packageVersion}`,
        `  src-tauri/tauri.conf.json: ${tauriVersion}`,
        `  src-tauri/Cargo.toml:      ${cargoVersion}`,
      ].join("\n"),
    );
  }

  const normalizedTag = normalizeTag(tag);
  if (normalizedTag) {
    const expectedTag = `v${packageVersion}`;
    if (normalizedTag !== expectedTag) {
      throw new Error(
        [
          "Release tag does not match manifest version:",
          `  Git tag:          ${normalizedTag}`,
          `  Expected tag:     ${expectedTag}`,
          `  Manifest version: ${packageVersion}`,
        ].join("\n"),
      );
    }
  }

  return {
    version: packageVersion,
    tag: normalizedTag || `v${packageVersion}`,
  };
}

/**
 * Reads the three manifest files from `repoRoot` and validates consistency.
 */
export function checkRepoVersions(repoRoot, tag = "") {
  const pkg = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  const tauriConf = JSON.parse(
    readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const cargoToml = readFileSync(
    resolve(repoRoot, "src-tauri/Cargo.toml"),
    "utf8",
  );

  return validateReleaseVersions({
    packageVersion: pkg.version,
    tauriVersion: tauriConf.version,
    cargoVersion: extractCargoVersion(cargoToml),
    tag,
  });
}

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    tag: process.env.RELEASE_TAG || "",
    githubOutput: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      opts.tag = argv[++i] ?? "";
    } else if (arg === "--root") {
      opts.root = argv[++i] ?? process.cwd();
    } else if (arg === "--github-output") {
      opts.githubOutput = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = checkRepoVersions(opts.root, opts.tag);
    if (opts.githubOutput && process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${result.version}\ntag=${result.tag}\n`,
        "utf8",
      );
    }
    const tagNote = normalizeTag(opts.tag)
      ? ` (matches tag ${result.tag})`
      : " (manifest-only check)";
    console.log(`Verified release version: ${result.version}${tagNote}`);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
