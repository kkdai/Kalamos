import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkRepoVersions } from "../scripts/check-release-version.mjs";
import { syncVersion } from "../scripts/sync-version.mjs";

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

  it("handles CRLF line endings in Cargo.toml, Cargo.lock, and JSON files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-sync-crlf-"));
    try {
      createFixtureRepo(dir, {
        targetVersion: "0.5.1-rc.1",
        oldVersion: "0.4.0",
        eol: "\r\n",
      });

      syncVersion(dir);
      const check = checkRepoVersions(dir, "v0.5.1-rc.1");
      assert.deepEqual(check, { version: "0.5.1-rc.1", tag: "v0.5.1-rc.1" });

      const cargoToml = readFileSync(join(dir, "src-tauri/Cargo.toml"), "utf8");
      assert.match(
        cargoToml,
        /name = "kalamos"\r\nversion = "0\.5\.1-rc\.1"\r\n/,
      );

      const cargoLock = readFileSync(join(dir, "src-tauri/Cargo.lock"), "utf8");
      assert.match(
        cargoLock,
        /name = "kalamos"\r\nversion = "0\.5\.1-rc\.1"\r\n/,
      );

      const tauriConf = readFileSync(
        join(dir, "src-tauri/tauri.conf.json"),
        "utf8",
      );
      assert.ok(tauriConf.includes("\r\n"));
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
});
