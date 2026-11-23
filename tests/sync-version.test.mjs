import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkRepoVersions } from "../scripts/check-release-version.mjs";
import { syncVersion } from "../scripts/sync-version.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIOME_BIN = resolve(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");
const MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function diffLines(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(
    afterLines.length,
    beforeLines.length,
    "Line count should remain identical after syncVersion",
  );
  const diffs = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] !== afterLines[i]) {
      diffs.push({
        line: i + 1,
        before: beforeLines[i],
        after: afterLines[i],
      });
    }
  }
  return diffs;
}

function copyRealRepoManifests(dir, { targetVersion, eol = null }) {
  mkdirSync(join(dir, "src-tauri"), { recursive: true });
  const originals = {};
  const currentVersion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  ).version;

  for (const relPath of MANIFEST_FILES) {
    let content = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
    if (eol === "\r\n") {
      content = content.replace(/\r?\n/g, "\r\n");
    }
    originals[relPath] = content;
    writeFileSync(join(dir, relPath), content, "utf8");
  }

  const bumpedPkg = originals["package.json"].replace(
    `"version": "${currentVersion}"`,
    `"version": "${targetVersion}"`,
  );
  assert.notEqual(
    bumpedPkg,
    originals["package.json"],
    "Expected package.json version line to be updated for test setup",
  );
  writeFileSync(join(dir, "package.json"), bumpedPkg, "utf8");

  return { currentVersion, originals, bumpedPkg };
}

function createFixtureRepo(
  dir,
  { targetVersion, oldVersion = "0.4.0", eol = "\n" },
) {
  mkdirSync(join(dir, "src-tauri"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "kalamos", version: targetVersion }, null, 2).replace(/\n/g, eol)}${eol}`,
    "utf8",
  );

  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "kalamos",
        version: oldVersion,
        lockfileVersion: 3,
        packages: {
          "": {
            name: "kalamos",
            version: oldVersion,
          },
          "node_modules/example": {
            version: "1.2.3",
          },
        },
      },
      null,
      2,
    ).replace(/\n/g, eol)}${eol}`,
    "utf8",
  );

  writeFileSync(
    join(dir, "src-tauri/tauri.conf.json"),
    `${JSON.stringify({ productName: "Kalamos", version: oldVersion }, null, 2).replace(/\n/g, eol)}${eol}`,
    "utf8",
  );

  writeFileSync(
    join(dir, "src-tauri/Cargo.toml"),
    [
      "[package]",
      'name = "kalamos"',
      `version = "${oldVersion}"`,
      'edition = "2021"',
      "",
      "[dependencies]",
      'serde = { version = "1" }',
      "",
    ].join(eol),
    "utf8",
  );

  writeFileSync(
    join(dir, "src-tauri/Cargo.lock"),
    [
      "[[package]]",
      'name = "other-crate"',
      'version = "1.0.0"',
      "",
      "[[package]]",
      'name = "kalamos"',
      `version = "${oldVersion}"`,
      "dependencies = []",
      "",
    ].join(eol),
    "utf8",
  );
}

describe("syncVersion", () => {
  it("synchronizes all manifests and passes checkRepoVersions", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0", oldVersion: "0.4.0" });

      const synced = syncVersion(dir);
      assert.equal(synced, "0.5.0");

      const check = checkRepoVersions(dir, "v0.5.0");
      assert.deepEqual(check, { version: "0.5.0", tag: "v0.5.0" });

      const lock = JSON.parse(
        readFileSync(join(dir, "package-lock.json"), "utf8"),
      );
      assert.equal(lock.version, "0.5.0");
      assert.equal(lock.packages[""].version, "0.5.0");
      assert.equal(lock.packages["node_modules/example"].version, "1.2.3");

      const cargoLock = readFileSync(join(dir, "src-tauri/Cargo.lock"), "utf8");
      assert.match(cargoLock, /name = "other-crate"\nversion = "1\.0\.0"/);
      assert.match(cargoLock, /name = "kalamos"\nversion = "0\.5\.0"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes only version lines on real repo manifests and keeps Biome formatting intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-real-"));
    try {
      const targetVersion = "9.8.7";
      const { currentVersion, originals, bumpedPkg } = copyRealRepoManifests(
        dir,
        { targetVersion },
      );

      const synced = syncVersion(dir);
      assert.equal(synced, targetVersion);
      assert.deepEqual(checkRepoVersions(dir, `v${targetVersion}`), {
        version: targetVersion,
        tag: `v${targetVersion}`,
      });

      // syncVersion must not rewrite package.json
      const syncedPkg = readFileSync(join(dir, "package.json"), "utf8");
      assert.equal(syncedPkg, bumpedPkg);

      // tauri.conf.json: only the single top-level version line changes
      const syncedTauri = readFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        "utf8",
      );
      const tauriDiffs = diffLines(
        originals["src-tauri/tauri.conf.json"],
        syncedTauri,
      );
      assert.equal(tauriDiffs.length, 1);
      assert.equal(tauriDiffs[0].before, `  "version": "${currentVersion}",`);
      assert.equal(tauriDiffs[0].after, `  "version": "${targetVersion}",`);

      // package-lock.json: only top-level version and packages[""].version change
      const syncedLock = readFileSync(join(dir, "package-lock.json"), "utf8");
      const lockDiffs = diffLines(originals["package-lock.json"], syncedLock);
      assert.equal(lockDiffs.length, 2);
      assert.equal(lockDiffs[0].before, `  "version": "${currentVersion}",`);
      assert.equal(lockDiffs[0].after, `  "version": "${targetVersion}",`);
      assert.equal(
        lockDiffs[1].before,
        `      "version": "${currentVersion}",`,
      );
      assert.equal(lockDiffs[1].after, `      "version": "${targetVersion}",`);

      // Cargo.toml & Cargo.lock: only the single kalamos version line changes
      for (const relPath of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
        const syncedCargo = readFileSync(join(dir, relPath), "utf8");
        const cargoDiffs = diffLines(originals[relPath], syncedCargo);
        assert.equal(cargoDiffs.length, 1);
        assert.equal(cargoDiffs[0].before, `version = "${currentVersion}"`);
        assert.equal(cargoDiffs[0].after, `version = "${targetVersion}"`);
      }

      // Integration check: Biome formatter reports zero diffs on synced JSON manifests
      for (const relPath of ["src-tauri/tauri.conf.json", "package.json"]) {
        const content = readFileSync(join(dir, relPath), "utf8");
        const formatted = execFileSync(
          process.execPath,
          [BIOME_BIN, "format", `--stdin-file-path=${relPath}`],
          { cwd: REPO_ROOT, input: content, encoding: "utf8" },
        );
        assert.equal(
          formatted,
          content,
          `Biome format should produce no changes for synced ${relPath}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves CRLF line endings and changes only version lines on real manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-crlf-"));
    try {
      const targetVersion = "0.5.1-rc.1";
      const { currentVersion, originals } = copyRealRepoManifests(dir, {
        targetVersion,
        eol: "\r\n",
      });

      syncVersion(dir);
      const check = checkRepoVersions(dir, `v${targetVersion}`);
      assert.deepEqual(check, {
        version: targetVersion,
        tag: `v${targetVersion}`,
      });

      const expectedDiffCounts = {
        "package-lock.json": 2,
        "src-tauri/tauri.conf.json": 1,
        "src-tauri/Cargo.toml": 1,
        "src-tauri/Cargo.lock": 1,
      };

      for (const [relPath, expectedCount] of Object.entries(
        expectedDiffCounts,
      )) {
        const synced = readFileSync(join(dir, relPath), "utf8");
        assert.ok(synced.includes("\r\n"), `${relPath} should keep CRLF`);
        assert.doesNotMatch(
          synced,
          /(?<!\r)\n/,
          `${relPath} should not contain bare LF`,
        );

        const diffs = diffLines(originals[relPath], synced);
        assert.equal(diffs.length, expectedCount);
        for (const d of diffs) {
          assert.equal(
            d.after,
            d.before.replace(currentVersion, targetVersion),
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves custom indentation, compact arrays, key order, nested versions, and trailing newline absence", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-format-"));
    try {
      createFixtureRepo(dir, { targetVersion: "1.2.3", oldVersion: "0.4.0" });

      const customTauri = [
        "{",
        '    "nested": { "version": "0.0.1", "tags": ["a", "b"] },',
        '    "productName": "Kalamos",',
        '    "version" : "0.4.0",',
        '    "ext": ["md", "markdown"]',
        "}",
      ].join("\n"); // intentionally no trailing newline
      writeFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        customTauri,
        "utf8",
      );

      syncVersion(dir);

      const actual = readFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        "utf8",
      );
      assert.equal(
        actual,
        customTauri.replace('"version" : "0.4.0"', '"version" : "1.2.3"'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if kalamos package version is missing in Cargo.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-err-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0" });
      writeFileSync(
        join(dir, "src-tauri/Cargo.toml"),
        '[package]\nname = "something-else"\nversion = "0.4.0"\n',
        "utf8",
      );

      assert.throws(
        () => syncVersion(dir),
        /Cannot find the kalamos package version in src-tauri\/Cargo\.toml/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if kalamos package version is missing in Cargo.lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-err-lock-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0" });
      writeFileSync(
        join(dir, "src-tauri/Cargo.lock"),
        '[[package]]\nname = "other-crate"\nversion = "1.0.0"\n',
        "utf8",
      );

      assert.throws(
        () => syncVersion(dir),
        /Cannot find the kalamos package version in src-tauri\/Cargo\.lock/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if top-level version is missing in tauri.conf.json even when nested version exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-err-tauri-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0" });
      writeFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        '{\n  "nested": { "version": "0.4.0" },\n  "productName": "Kalamos"\n}\n',
        "utf8",
      );

      assert.throws(
        () => syncVersion(dir),
        /Cannot find string version field "version" in src-tauri\/tauri\.conf\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if top-level version is missing in package-lock.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-err-pkglock-top-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0" });
      writeFileSync(
        join(dir, "package-lock.json"),
        '{\n  "name": "kalamos",\n  "packages": {\n    "": { "version": "0.4.0" }\n  }\n}\n',
        "utf8",
      );

      assert.throws(
        () => syncVersion(dir),
        /Cannot find string version field "version" in package-lock\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws if packages[""].version is missing in package-lock.json', () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-err-pkglock-root-"));
    try {
      createFixtureRepo(dir, { targetVersion: "0.5.0" });
      writeFileSync(
        join(dir, "package-lock.json"),
        '{\n  "name": "kalamos",\n  "version": "0.4.0",\n  "packages": {\n    "": { "name": "kalamos" }\n  }\n}\n',
        "utf8",
      );

      assert.throws(
        () => syncVersion(dir),
        /Cannot find string version field "packages\[""\]\.version" in package-lock\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
