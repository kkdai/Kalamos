import { describe, expect, it } from "vitest";
import { sha256Hex } from "./content-hash";
import {
  applySaveFileResult,
  canAutosave,
  createExternalChangeState,
  type DiskSnapshot,
  evaluateDiskCheck,
  isPathAffectedByFsEvent,
  needsAttentionBeforeClose,
} from "./external-change-state";

function snap(content: string, mtimeMs = 1000): DiskSnapshot {
  return {
    hash: sha256Hex(content),
    mtimeMs,
    size: new TextEncoder().encode(content).byteLength,
  };
}

describe("sha256Hex (matches Rust files::sha256_hex)", () => {
  it("matches NIST SHA-256 vectors and distinguishes line endings and CJK UTF-8", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Hex("a\nb")).not.toBe(sha256Hex("a\r\nb"));
    expect(sha256Hex("蘆葦筆")).toHaveLength(64);
  });
});

describe("external-change state machine", () => {
  const path = "/tmp/kalamos-test/doc.md";

  it("auto-reloads when disk changed and tab has no local unsaved edits", () => {
    const base = snap("# V1");
    const state = createExternalChangeState(base);
    const updated = snap("# V2 external", 2000);

    const decision = evaluateDiskCheck({
      state,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "exists", path, ...updated },
    });

    expect(decision.kind).toBe("autoReload");
    expect(decision.nextState.status).toBe("synced");
    expect(decision.nextState.baseline).toEqual(updated);
    expect(canAutosave(decision.nextState)).toBe(true);
  });

  it("enters conflict and pauses autosave when disk changed while local edits exist", () => {
    const base = snap("# V1");
    const state = createExternalChangeState(base);
    const external = snap("# V2 external", 2000);

    const decision = evaluateDiskCheck({
      state,
      localDirty: true,
      localContentHash: sha256Hex("# V1 local edit"),
      disk: { status: "exists", path, ...external },
    });

    expect(decision.kind).toBe("conflict");
    expect(decision.nextState.status).toBe("conflict");
    expect(decision.nextState.baseline).toEqual(base);
    expect(decision.nextState.diskSnapshot).toEqual(external);
    expect(canAutosave(decision.nextState)).toBe(false);
    expect(needsAttentionBeforeClose(decision.nextState, true)).toBe(true);
  });

  it("enters missing state and pauses autosave when file disappears from disk", () => {
    const base = snap("# V1");
    const state = createExternalChangeState(base);

    const decision = evaluateDiskCheck({
      state,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "missing", path },
    });

    expect(decision.kind).toBe("missing");
    expect(decision.nextState.status).toBe("missing");
    expect(decision.nextState.baseline).toEqual(base);
    expect(canAutosave(decision.nextState)).toBe(false);
    // Even without local edits, a missing file needs attention before closing.
    expect(needsAttentionBeforeClose(decision.nextState, false)).toBe(true);

    // Repeat check while already missing is a noop
    const again = evaluateDiskCheck({
      state: decision.nextState,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "missing", path },
    });
    expect(again.kind).toBe("noop");
  });

  it("returns noop when only mtime changed with identical hash (no false positives)", () => {
    const base = snap("# Same", 1000);
    const state = createExternalChangeState(base);
    const touched = snap("# Same", 9999);

    const decision = evaluateDiskCheck({
      state,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "exists", path, ...touched },
    });

    expect(decision.kind).toBe("noop");
    expect(decision.nextState.status).toBe("synced");
    expect(decision.nextState.baseline?.mtimeMs).toBe(9999);
  });

  it("resolves conflict when disk is reverted back to baseline or matches local content", () => {
    const base = snap("# V1", 1000);
    const conflictState = {
      status: "conflict" as const,
      baseline: base,
      diskSnapshot: snap("# External", 2000),
    };

    // Reverted externally to baseline -> conflict cleared, local changes remain dirty
    const reverted = evaluateDiskCheck({
      state: conflictState,
      localDirty: true,
      localContentHash: sha256Hex("# Local"),
      disk: { status: "exists", path, ...snap("# V1", 3000) },
    });
    expect(reverted.kind).toBe("resolved");
    if (reverted.kind === "resolved") {
      expect(reverted.markClean).toBe(false);
    }
    expect(reverted.nextState.status).toBe("synced");

    // Disk now matches local content -> conflict cleared & mark clean
    const matchedLocal = evaluateDiskCheck({
      state: conflictState,
      localDirty: true,
      localContentHash: sha256Hex("# Local"),
      disk: { status: "exists", path, ...snap("# Local", 4000) },
    });
    expect(matchedLocal.kind).toBe("resolved");
    if (matchedLocal.kind === "resolved") {
      expect(matchedLocal.markClean).toBe(true);
    }
    expect(matchedLocal.nextState.status).toBe("synced");
  });

  it("handles a missing file reappearing on disk (same vs modified)", () => {
    const base = snap("# V1", 1000);
    const missingState = {
      status: "missing" as const,
      baseline: base,
      diskSnapshot: null,
    };

    // Reappeared identical to local content -> resolved + clean
    const same = evaluateDiskCheck({
      state: missingState,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "exists", path, ...snap("# V1", 2000) },
    });
    expect(same.kind).toBe("resolved");
    expect(same.nextState.status).toBe("synced");

    // Reappeared with different content, no local edits -> autoReload
    const modifiedClean = evaluateDiskCheck({
      state: missingState,
      localDirty: false,
      localContentHash: base.hash,
      disk: { status: "exists", path, ...snap("# V2", 3000) },
    });
    expect(modifiedClean.kind).toBe("autoReload");

    // Reappeared with different content, with local edits -> conflict
    const modifiedDirty = evaluateDiskCheck({
      state: missingState,
      localDirty: true,
      localContentHash: sha256Hex("# Local"),
      disk: { status: "exists", path, ...snap("# V2", 3000) },
    });
    expect(modifiedDirty.kind).toBe("conflict");
  });

  it("applies pre-save SaveFileResult transitions accurately", () => {
    const base = snap("# V1", 1000);
    const state = createExternalChangeState(base);

    const saved = applySaveFileResult(state, {
      status: "saved",
      path,
      mtimeMs: 2000,
      size: 5,
      hash: sha256Hex("# V2!"),
    });
    expect(saved.kind).toBe("saved");
    expect(saved.nextState.status).toBe("synced");
    expect(saved.nextState.baseline?.hash).toBe(sha256Hex("# V2!"));

    const conflict = applySaveFileResult(saved.nextState, {
      status: "conflict",
      path,
      mtimeMs: 3000,
      size: 10,
      diskHash: sha256Hex("# External"),
    });
    expect(conflict.kind).toBe("conflict");
    expect(conflict.nextState.status).toBe("conflict");
    expect(canAutosave(conflict.nextState)).toBe(false);

    const missing = applySaveFileResult(saved.nextState, {
      status: "missing",
      path,
    });
    expect(missing.kind).toBe("missing");
    expect(missing.nextState.status).toBe("missing");
    expect(canAutosave(missing.nextState)).toBe(false);
  });

  it("matches affected paths across exact file, parent/ancestor dir, and Windows casing", () => {
    expect(
      isPathAffectedByFsEvent("/tmp/kalamos-test/a.md", [
        "/tmp/kalamos-test/a.md",
      ]),
    ).toBe(true);
    expect(
      isPathAffectedByFsEvent("/tmp/kalamos-test/a.md", [
        "/tmp/kalamos-test/b.md",
      ]),
    ).toBe(false);
    expect(
      isPathAffectedByFsEvent("/tmp/kalamos-test/sub/a.md", [
        "/tmp/kalamos-test/sub",
      ]),
    ).toBe(true);
    expect(
      isPathAffectedByFsEvent("/tmp/kalamos-test/sub2/a.md", [
        "/tmp/kalamos-test/sub",
      ]),
    ).toBe(false);
    expect(
      isPathAffectedByFsEvent(
        "C:/Temp/Kalamos-Test/Note.md",
        ["c:\\temp\\kalamos-test\\note.md"],
        true,
      ),
    ).toBe(true);
    expect(isPathAffectedByFsEvent(null, ["/tmp/kalamos-test/a.md"])).toBe(
      false,
    );
  });
});
