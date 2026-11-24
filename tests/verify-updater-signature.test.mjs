import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeMinisignPublicKey,
  decodeMinisignSignature,
  readPubkeyFromTauriConf,
  verifyMinisignSignature,
} from "../scripts/verify-updater-signature.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = resolve(
  __dirname,
  "../scripts/verify-updater-signature.mjs",
);
const TAURI_CONF_PATH = resolve(__dirname, "../src-tauri/tauri.conf.json");

function makeTestRoot() {
  mkdirSync("/tmp/kalamos-test", { recursive: true });
  return mkdtempSync("/tmp/kalamos-test/verify-sig-");
}

/**
 * Creates an in-memory ephemeral Ed25519 minisign key pair + signature helper
 * purely for unit-testing `verifyMinisignSignature` (never persisted to disk).
 */
function makeEphemeralMinisignSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  const keyId = Buffer.from("0102030405060708", "hex");

  const pubBody = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, rawPub]);
  const pubText = [
    "untrusted comment: minisign public key: 0807060504030201",
    pubBody.toString("base64"),
  ].join("\n");
  const tauriPubkey = Buffer.from(`${pubText}\n`, "utf8").toString("base64");

  function signBytes(data, { trustedComment, prehashed = true }) {
    const payload = prehashed
      ? createHash("blake2b512").update(data).digest()
      : data;
    const primarySig = cryptoSign(null, payload, privateKey);
    const alg = prehashed
      ? Buffer.from([0x45, 0x44])
      : Buffer.from([0x45, 0x64]);
    const sigBox = Buffer.concat([alg, keyId, primarySig]);
    const globalPayload = Buffer.concat([
      primarySig,
      Buffer.from(trustedComment, "utf8"),
    ]);
    const globalSig = cryptoSign(null, globalPayload, privateKey);
    const sigText = [
      "untrusted comment: signature from tauri secret key",
      sigBox.toString("base64"),
      `trusted comment: ${trustedComment}`,
      globalSig.toString("base64"),
    ].join("\n");
    return Buffer.from(`${sigText}\n`, "utf8").toString("base64");
  }

  return { tauriPubkey, signBytes };
}

describe("verify-updater-signature", () => {
  it("decodes the configured public key from src-tauri/tauri.conf.json", () => {
    const pubkey = readPubkeyFromTauriConf(TAURI_CONF_PATH);
    const decoded = decodeMinisignPublicKey(pubkey);
    assert.equal(decoded.keyId.length, 8);
    assert.equal(decoded.rawKey.length, 32);
  });

  it("matches the official minisign-verify test vector", () => {
    const officialPubkey =
      "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const officialSigText = [
      "untrusted comment: signature from minisign secret key",
      "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=",
      "trusted comment: timestamp:1555779966\tfile:test",
      "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==",
    ].join("\n");
    const officialSigBase64 = Buffer.from(officialSigText, "utf8").toString(
      "base64",
    );

    const parsed = decodeMinisignSignature(officialSigBase64);
    assert.equal(parsed.isPrehashed, false);
    assert.equal(parsed.trustedComment, "timestamp:1555779966\tfile:test");

    const ok = verifyMinisignSignature({
      data: Buffer.from("test", "utf8"),
      signatureBase64: officialSigBase64,
      pubkey: officialPubkey,
    });
    assert.equal(ok.isPrehashed, false);

    assert.throws(
      () =>
        verifyMinisignSignature({
          data: Buffer.from("Test", "utf8"),
          signatureBase64: officialSigBase64,
          pubkey: officialPubkey,
        }),
      /failed Ed25519 signature verification/,
    );
  });

  it("verifies prehashed (BLAKE2b-512) and legacy Ed25519 signatures and rejects tampering", () => {
    const { tauriPubkey, signBytes } = makeEphemeralMinisignSigner();
    const data = Buffer.from("kalamos updater binary payload", "utf8");

    for (const prehashed of [true, false]) {
      const sig = signBytes(data, {
        trustedComment:
          "timestamp:1732400000\tfile:Kalamos.app.tar.gz\tversion:0.8.0",
        prehashed,
      });

      const res = verifyMinisignSignature({
        data,
        signatureBase64: sig,
        pubkey: tauriPubkey,
        expectedVersion: "0.8.0",
        requireSignedVersion: true,
      });
      assert.equal(res.isPrehashed, prehashed);
      assert.equal(res.signedVersion, "0.8.0");

      // Tampered artifact bytes must fail
      assert.throws(
        () =>
          verifyMinisignSignature({
            data: Buffer.from("tampered payload", "utf8"),
            signatureBase64: sig,
            pubkey: tauriPubkey,
            expectedVersion: "0.8.0",
            requireSignedVersion: true,
          }),
        /failed Ed25519 signature verification/,
      );

      // Version mismatch must fail
      assert.throws(
        () =>
          verifyMinisignSignature({
            data,
            signatureBase64: sig,
            pubkey: tauriPubkey,
            expectedVersion: "0.9.0",
            requireSignedVersion: true,
          }),
        /does not match expected version/,
      );
    }

    // Tampered trusted comment must fail global signature check
    const goodSig = signBytes(data, {
      trustedComment:
        "timestamp:1732400000\tfile:Kalamos.app.tar.gz\tversion:0.8.0",
      prehashed: true,
    });
    const tamperedText = Buffer.from(goodSig, "base64")
      .toString("utf8")
      .replace("version:0.8.0", "version:0.9.0");
    const tamperedSig = Buffer.from(tamperedText, "utf8").toString("base64");
    assert.throws(
      () =>
        verifyMinisignSignature({
          data,
          signatureBase64: tamperedSig,
          pubkey: tauriPubkey,
          expectedVersion: "0.9.0",
        }),
      /failed Ed25519 global signature verification/,
    );

    // Missing signed version when required must fail
    const noVerSig = signBytes(data, {
      trustedComment: "timestamp:1732400000\tfile:Kalamos.app.tar.gz",
      prehashed: true,
    });
    assert.throws(
      () =>
        verifyMinisignSignature({
          data,
          signatureBase64: noVerSig,
          pubkey: tauriPubkey,
          expectedVersion: "0.8.0",
          requireSignedVersion: true,
        }),
      /missing required version field/,
    );

    // Wrong key must fail
    const other = makeEphemeralMinisignSigner();
    assert.throws(
      () =>
        verifyMinisignSignature({
          data,
          signatureBase64: goodSig,
          pubkey: other.tauriPubkey,
        }),
      /failed Ed25519 signature verification/,
    );
  });

  it("verifies via CLI and exits non-zero on invalid signature", () => {
    const dir = makeTestRoot();
    try {
      const { tauriPubkey, signBytes } = makeEphemeralMinisignSigner();
      const artifactPath = join(dir, "Kalamos_0.8.0_aarch64.app.tar.gz");
      const sigPath = `${artifactPath}.sig`;
      const payload = Buffer.from("tarball-bytes", "utf8");
      writeFileSync(artifactPath, payload);
      writeFileSync(
        sigPath,
        signBytes(payload, {
          trustedComment:
            "timestamp:1732400000\tfile:Kalamos_0.8.0_aarch64.app.tar.gz\tversion:0.8.0",
          prehashed: true,
        }),
        "utf8",
      );

      const stdout = execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--file",
          artifactPath,
          "--sig",
          sigPath,
          "--pubkey",
          tauriPubkey,
          "--version",
          "0.8.0",
          "--require-signed-version",
        ],
        { encoding: "utf8" },
      );
      assert.match(stdout, /Verified signature/);

      // Tamper with the artifact and confirm CLI fails
      writeFileSync(artifactPath, Buffer.from("tampered-bytes", "utf8"));
      assert.throws(() =>
        execFileSync(
          process.execPath,
          [
            SCRIPT_PATH,
            "--file",
            artifactPath,
            "--sig",
            sigPath,
            "--pubkey",
            tauriPubkey,
            "--version",
            "0.8.0",
            "--require-signed-version",
          ],
          { stdio: "pipe" },
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
