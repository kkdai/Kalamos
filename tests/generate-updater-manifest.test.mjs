import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUpdaterManifest,
  expectedPlatformAssets,
  REQUIRED_PLATFORMS,
  validateMinisignSignature,
  validateUpdaterManifest,
} from "../scripts/generate-updater-manifest.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = resolve(
  __dirname,
  "../scripts/generate-updater-manifest.mjs",
);

function makeTestRoot() {
  mkdirSync("/tmp/kalamos-test", { recursive: true });
  return mkdtempSync("/tmp/kalamos-test/updater-manifest-");
}

function makeSyntheticSig(fileName, version) {
  const payload = [
    "untrusted comment: signature from tauri secret key",
    "RWSWefbvGM0kpZzZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    `trusted comment: timestamp:1732400000\tfile:${fileName}\tversion:${version}`,
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ].join("\n");
  return Buffer.from(payload, "utf8").toString("base64");
}

function seedArtifacts(dir, version, sigVersion = version) {
  const assets = expectedPlatformAssets(version);
  for (const platform of REQUIRED_PLATFORMS) {
    const { file, sigFile } = assets[platform];
    writeFileSync(join(dir, file), `fake-binary-for-${platform}`, "utf8");
    writeFileSync(
      join(dir, sigFile),
      makeSyntheticSig(file, sigVersion),
      "utf8",
    );
  }
}

const SAMPLE_CHANGELOG = [
  "# kalamos",
  "",
  "## 0.8.0",
  "",
  "### Minor Changes",
  "",
  "- **自動更新**：支援應用程式內安全檢查、下載與安裝更新（#91）。",
  "",
  "## 0.7.0",
  "",
  "### Minor Changes",
  "",
  "- 介面語言切換",
  "",
].join("\n");

describe("validateMinisignSignature", () => {
  it("accepts a valid base64-encoded 4-line minisign signature", () => {
    const sig = makeSyntheticSig("Kalamos.app.tar.gz", "0.8.0");
    assert.equal(validateMinisignSignature(sig, "0.8.0"), sig);
  });

  it("rejects empty, non-base64, malformed, or version-mismatched signatures", () => {
    assert.throws(() => validateMinisignSignature("", "0.8.0"), /empty/);
    assert.throws(
      () => validateMinisignSignature("not-base64!!!", "0.8.0"),
      /valid base64/,
    );
    assert.throws(
      () =>
        validateMinisignSignature(
          Buffer.from("just one line", "utf8").toString("base64"),
          "0.8.0",
        ),
      /4-line minisign/,
    );
    assert.throws(
      () =>
        validateMinisignSignature(
          makeSyntheticSig("Kalamos.app.tar.gz", "0.7.0"),
          "0.8.0",
        ),
      /does not match expected version/,
    );
  });
});

describe("buildUpdaterManifest and validateUpdaterManifest", () => {
  it("builds a valid latest.json with all three platforms and CHANGELOG notes", () => {
    const dir = makeTestRoot();
    try {
      seedArtifacts(dir, "0.8.0");
      const manifest = buildUpdaterManifest({
        version: "0.8.0",
        tag: "v0.8.0",
        artifactsDir: dir,
        changelogText: SAMPLE_CHANGELOG,
        pubDate: "2026-11-24T12:00:00Z",
      });

      assert.equal(manifest.version, "0.8.0");
      assert.equal(manifest.pub_date, "2026-11-24T12:00:00Z");
      assert.match(manifest.notes, /自動更新/);
      assert.doesNotMatch(manifest.notes, /介面語言切換/);
      assert.deepEqual(
        Object.keys(manifest.platforms).sort(),
        [...REQUIRED_PLATFORMS].sort(),
      );
      assert.equal(
        manifest.platforms["darwin-aarch64"].url,
        "https://github.com/kkdai/Kalamos/releases/download/v0.8.0/Kalamos_0.8.0_aarch64.app.tar.gz",
      );
      assert.equal(
        manifest.platforms["darwin-x86_64"].url,
        "https://github.com/kkdai/Kalamos/releases/download/v0.8.0/Kalamos_0.8.0_x64.app.tar.gz",
      );
      assert.equal(
        manifest.platforms["windows-x86_64"].url,
        "https://github.com/kkdai/Kalamos/releases/download/v0.8.0/Kalamos_0.8.0_x64-setup.exe",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when any platform artifact or .sig file is missing", () => {
    const dir = makeTestRoot();
    try {
      seedArtifacts(dir, "0.8.0");
      rmSync(join(dir, "Kalamos_0.8.0_x64-setup.exe.sig"));
      assert.throws(
        () =>
          buildUpdaterManifest({
            version: "0.8.0",
            tag: "v0.8.0",
            artifactsDir: dir,
            pubDate: "2026-11-24T12:00:00Z",
          }),
        /Missing windows-x86_64 updater signature/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-HTTPS URLs, wrong URLs, bad pub_date, or tampered signatures", () => {
    const dir = makeTestRoot();
    try {
      seedArtifacts(dir, "0.8.0");
      const valid = buildUpdaterManifest({
        version: "0.8.0",
        tag: "v0.8.0",
        artifactsDir: dir,
        changelogText: SAMPLE_CHANGELOG,
        pubDate: "2026-11-24T12:00:00Z",
      });

      const httpUrl = structuredClone(valid);
      httpUrl.platforms["darwin-aarch64"].url = httpUrl.platforms[
        "darwin-aarch64"
      ].url.replace("https://", "http://");
      assert.throws(
        () =>
          validateUpdaterManifest(httpUrl, {
            version: "0.8.0",
            tag: "v0.8.0",
            artifactsDir: dir,
          }),
        /must use HTTPS/,
      );

      const badDate = structuredClone(valid);
      badDate.pub_date = "not-a-date";
      assert.throws(
        () =>
          validateUpdaterManifest(badDate, {
            version: "0.8.0",
            tag: "v0.8.0",
            artifactsDir: dir,
          }),
        /RFC 3339/,
      );

      const missingPlatform = structuredClone(valid);
      delete missingPlatform.platforms["darwin-x86_64"];
      assert.throws(
        () =>
          validateUpdaterManifest(missingPlatform, {
            version: "0.8.0",
            tag: "v0.8.0",
            artifactsDir: dir,
          }),
        /must exactly match required platforms/,
      );

      const tamperedSig = structuredClone(valid);
      tamperedSig.platforms["windows-x86_64"].signature = makeSyntheticSig(
        "other.exe",
        "0.8.0",
      );
      assert.throws(
        () =>
          validateUpdaterManifest(tamperedSig, {
            version: "0.8.0",
            tag: "v0.8.0",
            artifactsDir: dir,
          }),
        /does not match/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generate-updater-manifest CLI", () => {
  it("generates latest.json and passes --validate-only", () => {
    const dir = makeTestRoot();
    try {
      const artifactsDir = join(dir, "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      seedArtifacts(artifactsDir, "0.8.0");
      const changelogPath = join(dir, "CHANGELOG.md");
      writeFileSync(changelogPath, SAMPLE_CHANGELOG, "utf8");
      const outputPath = join(artifactsDir, "latest.json");

      execFileSync(process.execPath, [
        SCRIPT_PATH,
        "--version",
        "0.8.0",
        "--tag",
        "v0.8.0",
        "--artifacts-dir",
        artifactsDir,
        "--changelog",
        changelogPath,
        "--pub-date",
        "2026-11-24T12:00:00Z",
        "--output",
        outputPath,
      ]);

      const written = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(written.version, "0.8.0");
      assert.match(written.notes, /自動更新/);

      const stdout = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--validate-only",
          "--version",
          "0.8.0",
          "--tag",
          "v0.8.0",
          "--artifacts-dir",
          artifactsDir,
          "--manifest",
          outputPath,
        ],
        { encoding: "utf8" },
      );
      assert.match(stdout, /Verified updater manifest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cryptographically verifies all platform signatures when --pubkey is supplied", () => {
    const dir = makeTestRoot();
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const rawPub = publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      const keyId = Buffer.from("1122334455667788", "hex");
      const pubBody = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, rawPub]);
      const tauriPubkey = Buffer.from(
        `untrusted comment: minisign public key: test\n${pubBody.toString("base64")}\n`,
        "utf8",
      ).toString("base64");

      const artifactsDir = join(dir, "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      const assets = expectedPlatformAssets("0.8.0");
      for (const platform of REQUIRED_PLATFORMS) {
        const { file, sigFile } = assets[platform];
        const data = Buffer.from(`signed-binary-${platform}`, "utf8");
        const digest = createHash("blake2b512").update(data).digest();
        const primarySig = cryptoSign(null, digest, privateKey);
        const trustedComment = `timestamp:1732400000\tfile:${file}\tversion:0.8.0`;
        const globalSig = cryptoSign(
          null,
          Buffer.concat([primarySig, Buffer.from(trustedComment, "utf8")]),
          privateKey,
        );
        const sigBox = Buffer.concat([
          Buffer.from([0x45, 0x44]),
          keyId,
          primarySig,
        ]);
        const sigB64 = Buffer.from(
          [
            "untrusted comment: signature from tauri secret key",
            sigBox.toString("base64"),
            `trusted comment: ${trustedComment}`,
            globalSig.toString("base64"),
          ].join("\n"),
          "utf8",
        ).toString("base64");
        writeFileSync(join(artifactsDir, file), data);
        writeFileSync(join(artifactsDir, sigFile), sigB64, "utf8");
      }

      const outputPath = join(artifactsDir, "latest.json");
      execFileSync(process.execPath, [
        SCRIPT_PATH,
        "--version",
        "0.8.0",
        "--tag",
        "v0.8.0",
        "--artifacts-dir",
        artifactsDir,
        "--pubkey",
        tauriPubkey,
        "--pub-date",
        "2026-11-24T12:00:00Z",
        "--output",
        outputPath,
      ]);

      // Tampering with an artifact must fail --validate-only when --pubkey is given
      writeFileSync(
        join(artifactsDir, assets["darwin-aarch64"].file),
        "tampered-tarball",
        "utf8",
      );
      assert.throws(() =>
        execFileSync(
          process.execPath,
          [
            SCRIPT_PATH,
            "--validate-only",
            "--version",
            "0.8.0",
            "--tag",
            "v0.8.0",
            "--artifacts-dir",
            artifactsDir,
            "--pubkey",
            tauriPubkey,
            "--manifest",
            outputPath,
          ],
          { stdio: "pipe" },
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
