import type { UiLocale } from "../i18n";

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  identical: boolean;
}

const MAX_LCS_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}

/**
 * Line-level LCS diff between `oldText` (historical snapshot) and `newText` (current content).
 * Trims common prefix/suffix first so typical edits in large Markdown files stay fast, and
 * falls back to a bounded replace block if the changed core exceeds `MAX_LCS_CELLS`.
 */
export function computeLineDiff(oldText: string, newText: string): DiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldText === newText) {
    return {
      lines: oldLines.map((text, idx) => ({
        kind: "context",
        text,
        oldLine: idx + 1,
        newLine: idx + 1,
      })),
      added: 0,
      removed: 0,
      identical: true,
    };
  }

  let start = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (start < minLen && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) {
    lines.push({
      kind: "context",
      text: oldLines[i],
      oldLine: i + 1,
      newLine: i + 1,
    });
  }

  const m = oldEnd - start;
  const n = newEnd - start;
  let added = 0;
  let removed = 0;

  if (m === 0) {
    for (let j = 0; j < n; j++) {
      lines.push({
        kind: "added",
        text: newLines[start + j],
        oldLine: null,
        newLine: start + j + 1,
      });
      added++;
    }
  } else if (n === 0) {
    for (let i = 0; i < m; i++) {
      lines.push({
        kind: "removed",
        text: oldLines[start + i],
        oldLine: start + i + 1,
        newLine: null,
      });
      removed++;
    }
  } else if (m * n <= MAX_LCS_CELLS) {
    const stride = n + 1;
    const dp = new Uint32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
      const rowOffset = i * stride;
      const nextRowOffset = (i + 1) * stride;
      const oldLineText = oldLines[start + i];
      for (let j = n - 1; j >= 0; j--) {
        if (oldLineText === newLines[start + j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = Math.max(down, right);
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[start + i] === newLines[start + j]) {
        lines.push({
          kind: "context",
          text: oldLines[start + i],
          oldLine: start + i + 1,
          newLine: start + j + 1,
        });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
        lines.push({
          kind: "removed",
          text: oldLines[start + i],
          oldLine: start + i + 1,
          newLine: null,
        });
        removed++;
        i++;
      } else {
        lines.push({
          kind: "added",
          text: newLines[start + j],
          oldLine: null,
          newLine: start + j + 1,
        });
        added++;
        j++;
      }
    }
    while (i < m) {
      lines.push({
        kind: "removed",
        text: oldLines[start + i],
        oldLine: start + i + 1,
        newLine: null,
      });
      removed++;
      i++;
    }
    while (j < n) {
      lines.push({
        kind: "added",
        text: newLines[start + j],
        oldLine: null,
        newLine: start + j + 1,
      });
      added++;
      j++;
    }
  } else {
    // Fallback for huge completely rewritten documents so the UI never freezes.
    for (let i = 0; i < m; i++) {
      lines.push({
        kind: "removed",
        text: oldLines[start + i],
        oldLine: start + i + 1,
        newLine: null,
      });
      removed++;
    }
    for (let j = 0; j < n; j++) {
      lines.push({
        kind: "added",
        text: newLines[start + j],
        oldLine: null,
        newLine: start + j + 1,
      });
      added++;
    }
  }

  for (let i = oldEnd, j = newEnd; i < oldLines.length; i++, j++) {
    lines.push({
      kind: "context",
      text: oldLines[i],
      oldLine: i + 1,
      newLine: j + 1,
    });
  }

  return {
    lines,
    added,
    removed,
    identical: added === 0 && removed === 0 && oldText === newText,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function formatHistoryTimestamp(
  savedAtMs: number,
  locale: UiLocale,
): string {
  const date = new Date(savedAtMs);
  if (Number.isNaN(date.getTime())) return String(savedAtMs);
  try {
    return new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-TW" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 19);
  }
}
