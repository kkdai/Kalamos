import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkRepoVersions,
  extractCargoVersion,
  normalizeTag,
  validateReleaseVersions,
} from "../scripts/check-release-version.mjs";
import { formatReleaseNotes } from "../scripts/generate-release-notes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

describe("extractCargoVersion", () => {
  it("extracts version from [package] and ignores [dependencies]", () => {
    const toml = [
      "[dependencies]",
      'serde = { version = "1.0.0" }',
      'version = "9.9.9"',
      "",
      "[package]",
      'name = "kalamos"',
      'version = "0.3.0" # inline comment',
      'edition = "2021"',
      "",
      "[dev-dependencies]",
      'version = "8.8.8"',
    ].join("\n");

    assert.equal(extractCargoVersion(toml), "0.3.0");
  });

  it("throws when [package].version is missing", () => {
    const toml =
      '[package]\nname = "kalamos"\n[dependencies]\nversion = "1.0.0"\n';
    assert.throws(
      () => extractCargoVersion(toml),
      /Could not find \[package\]\.version/,
    );
  });
});

describe("normalizeTag", () => {
  it("strips refs/tags/ prefix and whitespace", () => {
    assert.equal(normalizeTag("refs/tags/v0.3.0"), "v0.3.0");
    assert.equal(normalizeTag("  v1.2.3-rc.1  "), "v1.2.3-rc.1");
    assert.equal(normalizeTag(""), "");
  });
});

describe("validateReleaseVersions", () => {
  it("passes when all manifests match and no tag is provided (workflow_dispatch)", () => {
    const result = validateReleaseVersions({
      packageVersion: "0.3.0",
      tauriVersion: "0.3.0",
      cargoVersion: "0.3.0",
    });
    assert.deepEqual(result, { version: "0.3.0", tag: "v0.3.0" });
  });

  it("passes when all manifests and tag match (including refs/tags/ and prerelease)", () => {
    const result = validateReleaseVersions({
      packageVersion: "0.4.0-rc.1",
      tauriVersion: "0.4.0-rc.1",
      cargoVersion: "0.4.0-rc.1",
      tag: "refs/tags/v0.4.0-rc.1",
    });
    assert.deepEqual(result, { version: "0.4.0-rc.1", tag: "v0.4.0-rc.1" });
  });

  it("fails when tag does not match manifest version", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3.0",
          tauriVersion: "0.3.0",
          cargoVersion: "0.3.0",
          tag: "v0.3.1",
        }),
      /Release tag does not match manifest version/,
    );
  });

  it("fails when tag lacks leading v", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3.0",
          tauriVersion: "0.3.0",
          cargoVersion: "0.3.0",
          tag: "0.3.0",
        }),
      /Expected tag:\s+v0\.3\.0/,
    );
  });

  it("fails when package.json version differs", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3.1",
          tauriVersion: "0.3.0",
          cargoVersion: "0.3.0",
          tag: "v0.3.0",
        }),
      /Version mismatch across project manifests/,
    );
  });

  it("fails when tauri.conf.json version differs", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3.0",
          tauriVersion: "0.3.1",
          cargoVersion: "0.3.0",
          tag: "v0.3.0",
        }),
      /Version mismatch across project manifests/,
    );
  });

  it("fails when Cargo.toml version differs", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3.0",
          tauriVersion: "0.3.0",
          cargoVersion: "0.2.0",
          tag: "v0.3.0",
        }),
      /Version mismatch across project manifests/,
    );
  });

  it("fails on invalid SemVer", () => {
    assert.throws(
      () =>
        validateReleaseVersions({
          packageVersion: "0.3",
          tauriVersion: "0.3",
          cargoVersion: "0.3",
        }),
      /Invalid or missing SemVer/,
    );
  });
});

describe("checkRepoVersions", () => {
  it("succeeds against the real repository manifests", () => {
    const result = checkRepoVersions(REPO_ROOT);
    assert.match(result.version, /^\d+\.\d+\.\d+/);
    assert.equal(result.tag, `v${result.version}`);
  });

  it("fails against a mismatched temporary workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-ver-"));
    try {
      mkdirSync(join(dir, "src-tauri"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      writeFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      writeFileSync(
        join(dir, "src-tauri/Cargo.toml"),
        '[package]\nname = "kalamos"\nversion = "1.0.1"\n',
      );
      assert.throws(
        () => checkRepoVersions(dir, "v1.0.0"),
        /Version mismatch across project manifests/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatReleaseNotes", () => {
  it("includes install instructions, unsigned warnings, and SHA-256 sums", () => {
    const checksumsText = [
      "aaaa  Kalamos_0.4.0_aarch64.dmg",
      "bbbb  Kalamos_0.4.0_x64.dmg",
      "cccc  Kalamos_0.4.0_x64-setup.exe",
      "dddd  Kalamos_0.4.0_x64_en-US.msi",
    ].join("\n");

    const notes = formatReleaseNotes({ version: "0.4.0", checksumsText });
    assert.match(notes, /## Kalamos v0\.4\.0/);
    assert.match(notes, /Kalamos_0\.4\.0_aarch64\.dmg/);
    assert.match(notes, /Kalamos_0\.4\.0_x64\.dmg/);
    assert.match(notes, /Kalamos_0\.4\.0_x64-setup\.exe/);
    assert.match(notes, /Kalamos_0\.4\.0_x64_en-US\.msi/);
    assert.match(notes, /未經 Apple 公證/);
    assert.match(notes, /SmartScreen/);
    assert.match(notes, /SHA256SUMS\.txt/);
    assert.match(notes, /aaaa {2}Kalamos_0\.4\.0_aarch64\.dmg/);
  });
});
