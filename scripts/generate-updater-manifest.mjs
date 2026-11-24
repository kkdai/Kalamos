#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractChangelogSection } from "./generate-release-notes.mjs";
import {
  readPubkeyFromTauriConf,
  verifyMinisignSignature,
} from "./verify-updater-signature.mjs";

export const DEFAULT_REPO = "kkdai/Kalamos";
export const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Expected updater artifact and signature filenames for a given SemVer version.
 */
export function expectedPlatformAssets(version) {
  return {
    "darwin-aarch64": {
      file: `Kalamos_${version}_aarch64.app.tar.gz`,
      sigFile: `Kalamos_${version}_aarch64.app.tar.gz.sig`,
    },
    "darwin-x86_64": {
      file: `Kalamos_${version}_x64.app.tar.gz`,
      sigFile: `Kalamos_${version}_x64.app.tar.gz.sig`,
    },
    "windows-x86_64": {
      file: `Kalamos_${version}_x64-setup.exe`,
      sigFile: `Kalamos_${version}_x64-setup.exe.sig`,
    },
  };
}

/**
 * Validates that a `.sig` payload is a base64-encoded minisign signature
 * matching Tauri updater's format (and optional `version:<semver>` trusted comment).
 */
export function validateMinisignSignature(
  rawSignature,
  expectedVersion = "",
  label = "signature",
) {
  if (typeof rawSignature !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = rawSignature.trim();
  if (!trimmed) {
    throw new Error(`${label} is empty`);
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(compact, "base64").toString("utf8");
  const lines = decoded
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));

  if (lines.length !== 4) {
    throw new Error(
      `${label} decoded to ${lines.length} lines; expected 4-line minisign signature`,
    );
  }
  if (!lines[0].startsWith("untrusted comment:")) {
    throw new Error(`${label} is missing minisign untrusted comment header`);
  }
  if (!lines[1].trim()) {
    throw new Error(`${label} is missing minisign signature body`);
  }
  if (!lines[2].startsWith("trusted comment:")) {
    throw new Error(`${label} is missing minisign trusted comment header`);
  }
  if (!lines[3].trim()) {
    throw new Error(`${label} is missing minisign global signature`);
  }

  if (expectedVersion) {
    const trustedBody = lines[2].slice("trusted comment:".length).trim();
    const versionField = trustedBody
      .split("\t")
      .find((part) => part.startsWith("version:"));
    if (versionField) {
      const signedVersion = versionField
        .slice("version:".length)
        .replace(/^v/, "");
      const normalizedExpected = expectedVersion.replace(/^v/, "");
      if (signedVersion !== normalizedExpected) {
        throw new Error(
          `${label} signed version (${signedVersion}) does not match expected version (${normalizedExpected})`,
        );
      }
    }
  }

  return trimmed;
}

function assertNonEmptyFile(filePath, description) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Empty or invalid ${description}: ${filePath}`);
  }
}

/**
 * Validates a `latest.json` object against expected release metadata and
 * (optionally) the staged artifacts directory on disk.
 */
export function validateUpdaterManifest(
  manifest,
  {
    version,
    tag = "",
    artifactsDir = "",
    pubkey = "",
    repo = DEFAULT_REPO,
  } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Updater manifest must be a JSON object");
  }

  const normalizedVersion = String(version ?? manifest.version ?? "")
    .trim()
    .replace(/^v/, "");
  if (!SEMVER_RE.test(normalizedVersion)) {
    throw new Error(
      `Invalid SemVer version: ${JSON.stringify(version ?? manifest.version)}`,
    );
  }
  if (manifest.version !== normalizedVersion) {
    throw new Error(
      `Manifest version (${JSON.stringify(manifest.version)}) does not match expected version (${normalizedVersion})`,
    );
  }

  const expectedTag = tag ? String(tag).trim() : `v${normalizedVersion}`;
  if (expectedTag !== `v${normalizedVersion}`) {
    throw new Error(
      `Release tag (${expectedTag}) does not match version (${normalizedVersion})`,
    );
  }

  if (typeof manifest.notes !== "string") {
    throw new Error("Manifest notes must be a string");
  }

  if (
    typeof manifest.pub_date !== "string" ||
    !RFC3339_RE.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    throw new Error(
      `Manifest pub_date must be a valid RFC 3339 timestamp: ${JSON.stringify(manifest.pub_date)}`,
    );
  }

  if (
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Array.isArray(manifest.platforms)
  ) {
    throw new Error("Manifest platforms must be an object");
  }

  const assets = expectedPlatformAssets(normalizedVersion);
  const manifestKeys = Object.keys(manifest.platforms).sort();
  const expectedKeys = [...REQUIRED_PLATFORMS].sort();
  if (
    manifestKeys.length !== expectedKeys.length ||
    manifestKeys.some((k, i) => k !== expectedKeys[i])
  ) {
    throw new Error(
      `Manifest platforms (${manifestKeys.join(", ")}) must exactly match required platforms (${expectedKeys.join(", ")})`,
    );
  }

  for (const platform of REQUIRED_PLATFORMS) {
    const entry = manifest.platforms[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Platform entry "${platform}" must be an object`);
    }
    const expected = assets[platform];
    const expectedUrl = `https://github.com/${repo}/releases/download/${expectedTag}/${expected.file}`;
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) {
      throw new Error(
        `Platform "${platform}" url must use HTTPS: ${JSON.stringify(entry.url)}`,
      );
    }
    if (entry.url !== expectedUrl) {
      throw new Error(
        `Platform "${platform}" url (${entry.url}) does not match expected release asset URL (${expectedUrl})`,
      );
    }

    const validatedSig = validateMinisignSignature(
      entry.signature,
      normalizedVersion,
      `platforms.${platform}.signature`,
    );

    if (artifactsDir) {
      const resolvedDir = resolve(artifactsDir);
      const artifactPath = join(resolvedDir, expected.file);
      const sigPath = join(resolvedDir, expected.sigFile);
      assertNonEmptyFile(artifactPath, `${platform} updater artifact`);
      assertNonEmptyFile(sigPath, `${platform} updater signature`);
      const diskSig = readFileSync(sigPath, "utf8").trim();
      if (diskSig !== validatedSig) {
        throw new Error(
          `Platform "${platform}" signature in manifest does not match ${expected.sigFile}`,
        );
      }
      if (pubkey) {
        verifyMinisignSignature({
          data: readFileSync(artifactPath),
          signatureBase64: validatedSig,
          pubkey,
          expectedVersion: normalizedVersion,
          requireSignedVersion: true,
          label: expected.sigFile,
        });
      }
    }
  }

  return manifest;
}

/**
 * Generates and validates `latest.json` from staged updater artifacts and CHANGELOG.md.
 */
export function buildUpdaterManifest({
  version,
  tag = "",
  artifactsDir,
  changelogText = "",
  pubDate = new Date().toISOString(),
  pubkey = "",
  repo = DEFAULT_REPO,
}) {
  const normalizedVersion = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  if (!SEMVER_RE.test(normalizedVersion)) {
    throw new Error(`Invalid SemVer version: ${JSON.stringify(version)}`);
  }
  const expectedTag = tag ? String(tag).trim() : `v${normalizedVersion}`;
  if (expectedTag !== `v${normalizedVersion}`) {
    throw new Error(
      `Release tag (${expectedTag}) does not match version (${normalizedVersion})`,
    );
  }
  if (!artifactsDir) {
    throw new Error("artifactsDir is required");
  }

  const resolvedDir = resolve(artifactsDir);
  const assets = expectedPlatformAssets(normalizedVersion);
  const platforms = {};

  for (const platform of REQUIRED_PLATFORMS) {
    const expected = assets[platform];
    const artifactPath = join(resolvedDir, expected.file);
    const sigPath = join(resolvedDir, expected.sigFile);
    assertNonEmptyFile(artifactPath, `${platform} updater artifact`);
    assertNonEmptyFile(sigPath, `${platform} updater signature`);

    const signature = validateMinisignSignature(
      readFileSync(sigPath, "utf8"),
      normalizedVersion,
      expected.sigFile,
    );
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${expectedTag}/${expected.file}`,
    };
  }

  const notes = extractChangelogSection(changelogText, normalizedVersion);
  const manifest = {
    version: normalizedVersion,
    notes,
    pub_date: pubDate,
    platforms,
  };

  return validateUpdaterManifest(manifest, {
    version: normalizedVersion,
    tag: expectedTag,
    artifactsDir: resolvedDir,
    pubkey,
    repo,
  });
}

function parseArgs(argv) {
  const opts = {
    version: "",
    tag: "",
    artifactsDir: "",
    changelogPath: "",
    hasExplicitChangelog: false,
    pubDate: "",
    pubkey: "",
    tauriConfPath: "",
    repo: DEFAULT_REPO,
    outputPath: "",
    manifestPath: "",
    validateOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") {
      opts.version = argv[++i] ?? "";
    } else if (arg === "--tag") {
      opts.tag = argv[++i] ?? "";
    } else if (arg === "--artifacts-dir") {
      opts.artifactsDir = argv[++i] ?? "";
    } else if (arg === "--changelog") {
      opts.changelogPath = argv[++i] ?? "";
      opts.hasExplicitChangelog = true;
    } else if (arg === "--pub-date") {
      opts.pubDate = argv[++i] ?? "";
    } else if (arg === "--pubkey") {
      opts.pubkey = argv[++i] ?? "";
    } else if (arg === "--tauri-conf") {
      opts.tauriConfPath = argv[++i] ?? "";
    } else if (arg === "--repo") {
      opts.repo = argv[++i] ?? DEFAULT_REPO;
    } else if (arg === "--output") {
      opts.outputPath = argv[++i] ?? "";
    } else if (arg === "--manifest") {
      opts.manifestPath = argv[++i] ?? "";
    } else if (arg === "--validate-only") {
      opts.validateOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.version) throw new Error("--version is required");
  if (!opts.artifactsDir) throw new Error("--artifacts-dir is required");
  if (opts.validateOnly && !opts.manifestPath) {
    throw new Error("--manifest is required when using --validate-only");
  }
  return opts;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const pubkey =
      opts.pubkey ||
      (opts.tauriConfPath ? readPubkeyFromTauriConf(opts.tauriConfPath) : "");
    if (opts.validateOnly) {
      const raw = readFileSync(resolve(opts.manifestPath), "utf8");
      const parsed = JSON.parse(raw);
      validateUpdaterManifest(parsed, {
        version: opts.version,
        tag: opts.tag,
        artifactsDir: opts.artifactsDir,
        pubkey,
        repo: opts.repo,
      });
      console.log(
        `Verified updater manifest ${opts.manifestPath} for v${opts.version} (${REQUIRED_PLATFORMS.join(", ")})`,
      );
    } else {
      let changelogText = "";
      if (opts.hasExplicitChangelog) {
        changelogText = readFileSync(resolve(opts.changelogPath), "utf8");
      } else {
        const defaultChangelogPath = resolve("CHANGELOG.md");
        if (existsSync(defaultChangelogPath)) {
          changelogText = readFileSync(defaultChangelogPath, "utf8");
        }
      }
      const manifest = buildUpdaterManifest({
        version: opts.version,
        tag: opts.tag,
        artifactsDir: opts.artifactsDir,
        changelogText,
        pubDate: opts.pubDate || new Date().toISOString(),
        pubkey,
        repo: opts.repo,
      });
      const json = `${JSON.stringify(manifest, null, 2)}\n`;
      if (opts.outputPath) {
        writeFileSync(resolve(opts.outputPath), json, "utf8");
      } else {
        process.stdout.write(json);
      }
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
