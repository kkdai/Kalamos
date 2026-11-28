/**
 * #145: pure state machine for tracking external disk modifications, deletions,
 * and renames on open named documents.
 */

import type { FileDiskState, SaveFileResult } from "../ipc";

export interface DiskSnapshot {
  hash: string;
  mtimeMs: number;
  size: number;
}

export type ExternalChangeStatus = "synced" | "conflict" | "missing";

export interface ExternalChangeState {
  status: ExternalChangeStatus;
  /** Disk snapshot at last open / reload / save. null when untitled or unknown (e.g. recovery before save). */
  baseline: DiskSnapshot | null;
  /** Most recently observed disk snapshot while status === "conflict". */
  diskSnapshot: DiskSnapshot | null;
}

export function createExternalChangeState(
  baseline: DiskSnapshot | null = null,
): ExternalChangeState {
  return {
    status: "synced",
    baseline,
    diskSnapshot: null,
  };
}

/** Autosave is paused while the tab has an unresolved external conflict or missing file. */
export function canAutosave(state: ExternalChangeState): boolean {
  return state.status === "synced";
}

/** Tabs with unsaved local edits OR unresolved external state must not be silently closed. */
export function needsAttentionBeforeClose(
  state: ExternalChangeState,
  localDirty: boolean,
): boolean {
  return localDirty || state.status !== "synced";
}

export interface DiskCheckInput {
  state: ExternalChangeState;
  localDirty: boolean;
  localContentHash: string;
  disk: FileDiskState;
}

export type DiskCheckDecision =
  | {
      kind: "noop";
      nextState: ExternalChangeState;
    }
  | {
      /** Disk was reverted or reappeared with identical content to baseline/local. */
      kind: "resolved";
      nextState: ExternalChangeState;
      markClean: boolean;
    }
  | {
      /** Disk content changed and there are no local unsaved changes: reload automatically. */
      kind: "autoReload";
      nextState: ExternalChangeState;
      snapshot: DiskSnapshot;
    }
  | {
      /** Disk content changed while local unsaved changes exist: pause autosave and ask user. */
      kind: "conflict";
      nextState: ExternalChangeState;
      snapshot: DiskSnapshot;
    }
  | {
      /** File disappeared from disk (deleted or renamed externally): pause autosave and notify user. */
      kind: "missing";
      nextState: ExternalChangeState;
    };

export function evaluateDiskCheck(input: DiskCheckInput): DiskCheckDecision {
  const { state, localDirty, localContentHash, disk } = input;

  if (disk.status === "missing") {
    if (state.status === "missing") {
      return { kind: "noop", nextState: state };
    }
    return {
      kind: "missing",
      nextState: {
        status: "missing",
        baseline: state.baseline,
        diskSnapshot: null,
      },
    };
  }

  const snapshot: DiskSnapshot = {
    hash: disk.hash,
    mtimeMs: disk.mtimeMs,
    size: disk.size,
  };

  // Unknown baseline (e.g. untitled or freshly restored recovery copy not yet saved):
  // do not falsely flag external changes until a save establishes the baseline.
  if (state.baseline === null) {
    return { kind: "noop", nextState: state };
  }

  // Case 1: Disk matches our current editor content byte-for-byte.
  if (snapshot.hash === localContentHash) {
    const nextState: ExternalChangeState = {
      status: "synced",
      baseline: snapshot,
      diskSnapshot: null,
    };
    if (state.status !== "synced" || localDirty) {
      return { kind: "resolved", nextState, markClean: true };
    }
    return { kind: "noop", nextState };
  }

  // Case 2: Disk matches our last loaded/saved baseline (no external change, or disk reverted back).
  if (snapshot.hash === state.baseline.hash) {
    const nextState: ExternalChangeState = {
      status: "synced",
      baseline: snapshot,
      diskSnapshot: null,
    };
    if (state.status !== "synced") {
      return { kind: "resolved", nextState, markClean: false };
    }
    return { kind: "noop", nextState };
  }

  // Case 3: Disk content genuinely diverged from baseline (and differs from local content).
  if (!localDirty) {
    return {
      kind: "autoReload",
      nextState: {
        status: "synced",
        baseline: snapshot,
        diskSnapshot: null,
      },
      snapshot,
    };
  }

  return {
    kind: "conflict",
    nextState: {
      status: "conflict",
      baseline: state.baseline,
      diskSnapshot: snapshot,
    },
    snapshot,
  };
}

export type SaveOutcomeDecision =
  | {
      kind: "saved";
      nextState: ExternalChangeState;
    }
  | {
      kind: "conflict";
      nextState: ExternalChangeState;
    }
  | {
      kind: "missing";
      nextState: ExternalChangeState;
    };

export function applySaveFileResult(
  state: ExternalChangeState,
  result: SaveFileResult,
): SaveOutcomeDecision {
  if (result.status === "saved") {
    return {
      kind: "saved",
      nextState: {
        status: "synced",
        baseline: {
          hash: result.hash,
          mtimeMs: result.mtimeMs,
          size: result.size,
        },
        diskSnapshot: null,
      },
    };
  }
  if (result.status === "conflict") {
    return {
      kind: "conflict",
      nextState: {
        status: "conflict",
        baseline: state.baseline,
        diskSnapshot: {
          hash: result.diskHash,
          mtimeMs: result.mtimeMs,
          size: result.size,
        },
      },
    };
  }
  return {
    kind: "missing",
    nextState: {
      status: "missing",
      baseline: state.baseline,
      diskSnapshot: null,
    },
  };
}

function normalizeForCompare(path: string, caseInsensitive: boolean): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/**
 * Returns true if any path in `changedPaths` could affect `tabPath`
 * (exact file match, or an ancestor directory was modified/renamed/deleted).
 */
export function isPathAffectedByFsEvent(
  tabPath: string | null,
  changedPaths: readonly string[],
  caseInsensitive = false,
): boolean {
  if (!tabPath) return false;
  const target = normalizeForCompare(tabPath, caseInsensitive);
  for (const raw of changedPaths) {
    if (!raw) continue;
    const changed = normalizeForCompare(raw, caseInsensitive);
    if (changed === target) return true;
    if (changed === "/") return true;
    if (target.startsWith(`${changed}/`)) return true;
  }
  return false;
}
