#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// RFC 8410 DER SubjectPublicKeyInfo prefix for a 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeStrictBase64(input, label) {
  if (typeof input !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const compact = input.trim().replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new Error(`${label} is not valid base64`);
  }
  return Buffer.from(compact, "base64");
}

function splitNonEmptyTrailingLines(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Decodes a minisign public key from either the Tauri base64-wrapped format
 * (as stored in `tauri.conf.json` `plugins.updater.pubkey`) or raw 2-line /
 * 1-line minisign public key text.
 */
export function decodeMinisignPublicKey(rawPubkey) {
  if (typeof rawPubkey !== "string" || !rawPubkey.trim()) {
    throw new Error("Public key is empty");
  }
  const trimmed = rawPubkey.trim();
  let keyLine;

  if (trimmed.includes("\n")) {
    const lines = splitNonEmptyTrailingLines(trimmed);
    if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:")) {
      throw new Error("Invalid 2-line minisign public key");
    }
    keyLine = lines[1].trim();
  } else {
    const decodedBuf = decodeStrictBase64(trimmed, "public key");
    if (decodedBuf.length === 42) {
      keyLine = trimmed;
    } else {
      const text = decodedBuf.toString("utf8");
      const lines = splitNonEmptyTrailingLines(text);
      if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:")) {
        throw new Error(
          "Decoded public key must be a 2-line minisign public key",
        );
      }
      keyLine = lines[1].trim();
    }
  }

  const bin = decodeStrictBase64(keyLine, "public key body");
  if (bin.length !== 42) {
    throw new Error(
      `Invalid minisign public key length (${bin.length} bytes; expected 42)`,
    );
  }
  const alg0 = bin[0];
  const alg1 = bin[1];
  if (alg0 !== 0x45 || (alg1 !== 0x64 && alg1 !== 0x44)) {
    throw new Error("Unsupported minisign public key algorithm");
  }

  const keyId = bin.subarray(2, 10);
  const rawKey = bin.subarray(10, 42);
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });

  return { keyId, rawKey, keyObject };
}

/**
 * Decodes a Tauri `.sig` file payload (base64-encoded 4-line minisign signature).
 */
export function decodeMinisignSignature(rawSignature, label = "signature") {
  const outerBuf = decodeStrictBase64(rawSignature, label);
  const text = outerBuf.toString("utf8");
  const lines = splitNonEmptyTrailingLines(text);
  if (lines.length !== 4) {
    throw new Error(
      `${label} decoded to ${lines.length} lines; expected 4-line minisign signature`,
    );
  }
  if (!lines[0].startsWith("untrusted comment:")) {
    throw new Error(`${label} is missing minisign untrusted comment header`);
  }
  if (!lines[2].startsWith("trusted comment: ")) {
    throw new Error(`${label} is missing minisign trusted comment header`);
  }

  const bin1 = decodeStrictBase64(lines[1], `${label} primary signature`);
  if (bin1.length !== 74) {
    throw new Error(
      `${label} primary signature has invalid length (${bin1.length} bytes; expected 74)`,
    );
  }
  const globalSignature = decodeStrictBase64(
    lines[3],
    `${label} global signature`,
  );
  if (globalSignature.length !== 64) {
    throw new Error(
      `${label} global signature has invalid length (${globalSignature.length} bytes; expected 64)`,
    );
  }

  let isPrehashed;
  if (bin1[0] === 0x45 && bin1[1] === 0x64) {
    isPrehashed = false;
  } else if (bin1[0] === 0x45 && bin1[1] === 0x44) {
    isPrehashed = true;
  } else {
    throw new Error(`${label} uses unsupported minisign signature algorithm`);
  }

  return {
    untrustedComment: lines[0],
    trustedComment: lines[2].slice("trusted comment: ".length),
    keyId: bin1.subarray(2, 10),
    signature: bin1.subarray(10, 74),
    globalSignature,
    isPrehashed,
  };
}

/**
 * Extracts `version:<value>` from a minisign trusted comment (tab-separated fields).
 */
export function extractSignedVersion(trustedComment) {
  const field = trustedComment
    .split("\t")
    .find((part) => part.startsWith("version:"));
  return field ? field.slice("version:".length) : null;
}

/**
 * Cryptographically verifies a Tauri updater artifact against its `.sig` payload
 * and minisign public key, matching `tauri-plugin-updater` / `minisign-verify`.
 */
export function verifyMinisignSignature({
  data,
  signatureBase64,
  pubkey,
  expectedVersion = "",
  requireSignedVersion = false,
  label = "signature",
}) {
  const pub = decodeMinisignPublicKey(pubkey);
  const sig = decodeMinisignSignature(signatureBase64, label);

  if (!pub.keyId.equals(sig.keyId)) {
    throw new Error(`${label} key ID does not match configured public key`);
  }

  const payload = sig.isPrehashed
    ? createHash("blake2b512").update(data).digest()
    : data;

  const primaryOk = cryptoVerify(null, payload, pub.keyObject, sig.signature);
  if (!primaryOk) {
    throw new Error(`${label} failed Ed25519 signature verification`);
  }

  const globalPayload = Buffer.concat([
    sig.signature,
    Buffer.from(sig.trustedComment, "utf8"),
  ]);
  const globalOk = cryptoVerify(
    null,
    globalPayload,
    pub.keyObject,
    sig.globalSignature,
  );
  if (!globalOk) {
    throw new Error(`${label} failed Ed25519 global signature verification`);
  }

  const signedVersion = extractSignedVersion(sig.trustedComment);
  if (requireSignedVersion && !signedVersion) {
    throw new Error(
      `${label} trusted comment is missing required version field`,
    );
  }
  if (expectedVersion && signedVersion) {
    const normalizedSigned = signedVersion.trim().replace(/^v/, "");
    const normalizedExpected = expectedVersion.trim().replace(/^v/, "");
    if (normalizedSigned !== normalizedExpected) {
      throw new Error(
        `${label} signed version (${normalizedSigned}) does not match expected version (${normalizedExpected})`,
      );
    }
  }

  return {
    trustedComment: sig.trustedComment,
    signedVersion,
    isPrehashed: sig.isPrehashed,
  };
}

export function readPubkeyFromTauriConf(tauriConfPath) {
  const conf = JSON.parse(readFileSync(resolve(tauriConfPath), "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || !pubkey.trim()) {
    throw new Error(`Missing plugins.updater.pubkey in ${tauriConfPath}`);
  }
  return pubkey.trim();
}

function parseArgs(argv) {
  const opts = {
    filePath: "",
    sigPath: "",
    pubkey: "",
    tauriConfPath: "",
    version: "",
    requireSignedVersion: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      opts.filePath = argv[++i] ?? "";
    } else if (arg === "--sig") {
      opts.sigPath = argv[++i] ?? "";
    } else if (arg === "--pubkey") {
      opts.pubkey = argv[++i] ?? "";
    } else if (arg === "--tauri-conf") {
      opts.tauriConfPath = argv[++i] ?? "";
    } else if (arg === "--version") {
      opts.version = argv[++i] ?? "";
    } else if (arg === "--require-signed-version") {
      opts.requireSignedVersion = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.filePath) throw new Error("--file is required");
  if (!opts.sigPath) throw new Error("--sig is required");
  if (!opts.pubkey && !opts.tauriConfPath) {
    throw new Error("Either --pubkey or --tauri-conf is required");
  }
  return opts;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const pubkey = opts.pubkey || readPubkeyFromTauriConf(opts.tauriConfPath);
    const data = readFileSync(resolve(opts.filePath));
    if (data.length === 0) {
      throw new Error(`Artifact file is empty: ${opts.filePath}`);
    }
    const signatureBase64 = readFileSync(resolve(opts.sigPath), "utf8").trim();
    const result = verifyMinisignSignature({
      data,
      signatureBase64,
      pubkey,
      expectedVersion: opts.version,
      requireSignedVersion: opts.requireSignedVersion,
      label: opts.sigPath,
    });
    console.log(
      `Verified signature ${opts.sigPath} for ${opts.filePath} (prehashed=${result.isPrehashed}${result.signedVersion ? `, version=${result.signedVersion}` : ""})`,
    );
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
