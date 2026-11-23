/**
 * #104: fast frontend fuzzy matcher for Quick Open.
 *
 * Designed to score 10,000+ Markdown paths well within a 16ms frame:
 * - Precomputes lowercase strings, filename offsets, and a 32-bit ASCII char
 *   bitmask once when the folder path cache loads (not on every keystroke).
 * - Rejects non-matching paths in O(1) via bitmask, then O(n) subsequence check.
 * - Uses O(qLen * tLen) DP with reused Int32Array buffers (zero GC pressure)
 *   to find optimal character positions for scoring and highlighting.
 * - Strongly prefers filename matches over path-only matches, rewards
 *   consecutive hits, prefix / segment-start / word-boundary hits, and boosts
 *   recently opened files.
 */
import { MAX_RECENT_FILES } from "./recent-files";

export const MAX_QUICK_OPEN_RESULTS = 50;

export interface PreparedCandidate {
  path: string;
  /** File basename (e.g. "shortcuts.md"). */
  name: string;
  nameLower: string;
  /** Parent directory relative to folder root ("" for root), or parent dir for external files. */
  dir: string;
  /** Relative path (e.g. "guides/shortcuts.md") or full path when outside folder root. */
  relPath: string;
  relPathLower: string;
  /** Character offset of `name` inside `relPath`. */
  nameOffset: number;
  /** 32-bit ASCII character bitmask for O(1) pre-filtering. */
  asciiMask: number;
  /** 32-bit ASCII character bitmask of `nameLower` alone. */
  nameMask: number;
}

export interface QuickOpenMatch {
  path: string;
  name: string;
  dir: string;
  nameMatches: number[];
  dirMatches: number[];
  score: number;
  isRecent: boolean;
}

const DP_MAX_Q = 32;
const DP_MAX_T = 160;
const NEG_INF = -1_000_000;

// Reusable DP buffers so scoring thousands of candidates allocates no typed arrays.
const dpScore = new Int32Array(DP_MAX_Q * DP_MAX_T);
const dpPrev = new Int32Array(DP_MAX_Q * DP_MAX_T);

const BASE_CHAR_SCORE = 10;
const CONSECUTIVE_BONUS = 15;
const START_BONUS = 20;
const SEGMENT_START_BONUS = 18;
const WORD_BOUNDARY_BONUS = 12;
const CASE_MATCH_BONUS = 2;
const GAP_PENALTY = 1;
const LEAD_PENALTY = 1;
const FILENAME_ONLY_BONUS = 100;
const EXACT_STEM_BONUS = 40;
const RECENCY_MAX_BONUS = 25;

/** 32-bit mask: bits 0..25 for a-z, bits 26..31 for digits/punctuation folded. */
export function computeAsciiMask(lower: string): number {
  let mask = 0;
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      mask |= 1 << (code - 97);
    } else if (code >= 48 && code <= 57) {
      mask |= 1 << (26 + ((code - 48) % 6));
    }
  }
  return mask;
}

function splitPathParts(
  fullPath: string,
  folderRoot: string | null,
): { name: string; dir: string; relPath: string } {
  const slash = fullPath.lastIndexOf("/");
  const name = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
  const parent = slash > 0 ? fullPath.slice(0, slash) : slash === 0 ? "/" : "";

  if (folderRoot) {
    const base = folderRoot.replace(/\/+$/, "");
    const prefix = base === "/" ? "/" : `${base}/`;
    if (fullPath.startsWith(prefix)) {
      const relPath = fullPath.slice(prefix.length);
      const relSlash = relPath.lastIndexOf("/");
      const dir = relSlash >= 0 ? relPath.slice(0, relSlash) : "";
      return { name, dir, relPath };
    }
  }

  return { name, dir: parent, relPath: fullPath };
}

export function prepareSingleCandidate(
  path: string,
  folderRoot: string | null,
): PreparedCandidate {
  const { name, dir, relPath } = splitPathParts(path, folderRoot);
  const nameLower = name.toLowerCase();
  const relPathLower = relPath.toLowerCase();
  const nameOffset = relPath.length - name.length;
  return {
    path,
    name,
    nameLower,
    dir,
    relPath,
    relPathLower,
    nameOffset,
    asciiMask: computeAsciiMask(relPathLower),
    nameMask: computeAsciiMask(nameLower),
  };
}

export function prepareCandidates(
  paths: readonly string[],
  folderRoot: string | null,
): PreparedCandidate[] {
  const out = new Array<PreparedCandidate>(paths.length);
  for (let i = 0; i < paths.length; i++) {
    out[i] = prepareSingleCandidate(paths[i], folderRoot);
  }
  return out;
}

function isSubsequence(queryLower: string, textLower: string): boolean {
  let pos = 0;
  for (let i = 0; i < queryLower.length; i++) {
    const idx = textLower.indexOf(queryLower[i], pos);
    if (idx === -1) return false;
    pos = idx + 1;
  }
  return true;
}

function positionBonus(text: string, idx: number): number {
  if (idx === 0) return START_BONUS;
  const prev = text.charCodeAt(idx - 1);
  // Path separator '/' (47) or '\' (92)
  if (prev === 47 || prev === 92) return SEGMENT_START_BONUS;
  // '-', '_', '.', ' '
  if (prev === 45 || prev === 95 || prev === 46 || prev === 32) {
    return WORD_BOUNDARY_BONUS;
  }
  // camelCase boundary: lowercase followed by uppercase
  const curr = text.charCodeAt(idx);
  if (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90) {
    return WORD_BOUNDARY_BONUS;
  }
  return 0;
}

interface TextMatch {
  score: number;
  positions: number[];
}

/** Fast path for a 1-character query (avoids DP over thousands of candidates). */
function scoreSingleChar(
  text: string,
  textLower: string,
  qChar: string,
  qCharLower: string,
): TextMatch | null {
  let bestIdx = -1;
  let bestScore = NEG_INF;
  let pos = textLower.indexOf(qCharLower, 0);
  while (pos !== -1) {
    const s =
      BASE_CHAR_SCORE +
      positionBonus(text, pos) +
      (text[pos] === qChar ? CASE_MATCH_BONUS : 0) -
      Math.min(pos, 40) * LEAD_PENALTY;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = pos;
    }
    pos = textLower.indexOf(qCharLower, pos + 1);
  }
  return bestIdx === -1 ? null : { score: bestScore, positions: [bestIdx] };
}

/** Fallback greedy matcher for unusually long strings beyond DP buffer dimensions. */
function scoreGreedy(
  text: string,
  textLower: string,
  query: string,
  queryLower: string,
): TextMatch | null {
  const positions: number[] = [];
  let score = 0;
  let prev = -1;
  let searchFrom = 0;
  for (let qi = 0; qi < queryLower.length; qi++) {
    const idx = textLower.indexOf(queryLower[qi], searchFrom);
    if (idx === -1) return null;
    positions.push(idx);
    score += BASE_CHAR_SCORE + positionBonus(text, idx);
    if (text[idx] === query[qi]) score += CASE_MATCH_BONUS;
    if (prev !== -1) {
      if (idx === prev + 1) score += CONSECUTIVE_BONUS;
      else score -= (idx - prev - 1) * GAP_PENALTY;
    } else {
      score -= Math.min(idx, 40) * LEAD_PENALTY;
    }
    prev = idx;
    searchFrom = idx + 1;
  }
  return { score, positions };
}

/** Optimal subsequence alignment using O(qLen * tLen) DP with zero typed-array allocations. */
export function fuzzyScoreText(
  text: string,
  textLower: string,
  query: string,
  queryLower: string,
): TextMatch | null {
  const qLen = queryLower.length;
  const tLen = textLower.length;
  if (qLen === 0 || qLen > tLen) return null;

  if (qLen === 1) {
    return scoreSingleChar(text, textLower, query[0], queryLower[0]);
  }
  if (!isSubsequence(queryLower, textLower)) return null;
  if (qLen > DP_MAX_Q || tLen > DP_MAX_T) {
    return scoreGreedy(text, textLower, query, queryLower);
  }

  // Row 0
  const q0Lower = queryLower[0];
  const q0 = query[0];
  for (let ti = 0; ti < tLen; ti++) {
    if (textLower[ti] === q0Lower) {
      dpScore[ti] =
        BASE_CHAR_SCORE +
        positionBonus(text, ti) +
        (text[ti] === q0 ? CASE_MATCH_BONUS : 0) -
        Math.min(ti, 40) * LEAD_PENALTY;
      dpPrev[ti] = -1;
    } else {
      dpScore[ti] = NEG_INF;
      dpPrev[ti] = -1;
    }
  }

  // Rows 1..qLen-1
  for (let qi = 1; qi < qLen; qi++) {
    const rowOff = qi * tLen;
    const prevRowOff = rowOff - tLen;
    const qcLower = queryLower[qi];
    const qc = query[qi];

    let bestGap = NEG_INF;
    let bestGapIdx = -1;

    for (let ti = 0; ti < tLen; ti++) {
      // Advance non-consecutive best: candidates k <= ti - 2 decay by GAP_PENALTY.
      if (ti >= 2) {
        if (bestGap > NEG_INF) bestGap -= GAP_PENALTY;
        const candScore = dpScore[prevRowOff + ti - 2];
        if (candScore > NEG_INF) {
          const withGap = candScore - GAP_PENALTY;
          if (withGap > bestGap) {
            bestGap = withGap;
            bestGapIdx = ti - 2;
          }
        }
      }

      if (ti < qi || textLower[ti] !== qcLower) {
        dpScore[rowOff + ti] = NEG_INF;
        dpPrev[rowOff + ti] = -1;
        continue;
      }

      const consecPrev = dpScore[prevRowOff + ti - 1];
      const consecScore =
        consecPrev > NEG_INF ? consecPrev + CONSECUTIVE_BONUS : NEG_INF;

      let chosenPrev: number;
      let chosenBase: number;
      if (consecScore >= bestGap && consecScore > NEG_INF) {
        chosenBase = consecScore;
        chosenPrev = ti - 1;
      } else if (bestGap > NEG_INF) {
        chosenBase = bestGap;
        chosenPrev = bestGapIdx;
      } else {
        dpScore[rowOff + ti] = NEG_INF;
        dpPrev[rowOff + ti] = -1;
        continue;
      }

      const bonus =
        BASE_CHAR_SCORE +
        positionBonus(text, ti) +
        (text[ti] === qc ? CASE_MATCH_BONUS : 0);
      dpScore[rowOff + ti] = chosenBase + bonus;
      dpPrev[rowOff + ti] = chosenPrev;
    }
  }

  const lastRowOff = (qLen - 1) * tLen;
  let bestEnd = -1;
  let bestScore = NEG_INF;
  for (let ti = qLen - 1; ti < tLen; ti++) {
    const s = dpScore[lastRowOff + ti];
    if (s > bestScore) {
      bestScore = s;
      bestEnd = ti;
    }
  }
  if (bestEnd === -1) return null;

  const positions = new Array<number>(qLen);
  let cur = bestEnd;
  for (let qi = qLen - 1; qi >= 0; qi--) {
    positions[qi] = cur;
    cur = dpPrev[qi * tLen + cur];
  }
  return { score: bestScore, positions };
}

function scoreCandidate(
  cand: PreparedCandidate,
  query: string,
  queryLower: string,
  queryMask: number,
  recentRank: number,
): QuickOpenMatch | null {
  if ((cand.asciiMask & queryMask) !== queryMask) return null;

  const isRecent = recentRank >= 0;
  const recencyBonus = isRecent
    ? Math.max(1, RECENCY_MAX_BONUS - recentRank)
    : 0;
  const lengthPenalty =
    Math.min(cand.name.length, 60) * 0.2 +
    Math.min(cand.relPath.length, 120) * 0.05;

  // 1. Prefer matching inside the filename alone.
  if (
    queryLower.length <= cand.nameLower.length &&
    (cand.nameMask & queryMask) === queryMask
  ) {
    const nameHit = fuzzyScoreText(
      cand.name,
      cand.nameLower,
      query,
      queryLower,
    );
    if (nameHit) {
      const dotIdx = cand.nameLower.lastIndexOf(".");
      const stem =
        dotIdx > 0 ? cand.nameLower.slice(0, dotIdx) : cand.nameLower;
      const exactBonus =
        cand.nameLower === queryLower || stem === queryLower
          ? EXACT_STEM_BONUS
          : 0;
      return {
        path: cand.path,
        name: cand.name,
        dir: cand.dir,
        nameMatches: nameHit.positions,
        dirMatches: [],
        score:
          nameHit.score +
          FILENAME_ONLY_BONUS +
          exactBonus +
          recencyBonus -
          lengthPenalty,
        isRecent,
      };
    }
  }

  // 2. Fall back to matching across the relative path (dir + "/" + name).
  const pathHit = fuzzyScoreText(
    cand.relPath,
    cand.relPathLower,
    query,
    queryLower,
  );
  if (!pathHit) return null;

  const nameMatches: number[] = [];
  const dirMatches: number[] = [];
  const dirEnd = cand.dir.length;
  for (const pos of pathHit.positions) {
    if (pos >= cand.nameOffset) {
      nameMatches.push(pos - cand.nameOffset);
    } else if (pos < dirEnd) {
      dirMatches.push(pos);
    }
  }
  // Small reward for each character landing in the filename portion.
  const nameCharBonus = nameMatches.length * 4;

  return {
    path: cand.path,
    name: cand.name,
    dir: cand.dir,
    nameMatches,
    dirMatches,
    score: pathHit.score + nameCharBonus + recencyBonus - lengthPenalty,
    isRecent,
  };
}

function compareMatches(a: QuickOpenMatch, b: QuickOpenMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Searches `candidates` (cached folder files) and `recentFiles`.
 * - Empty query: returns up to 20 recent files, newest first.
 * - Non-empty query: fuzzy-matches folder files + external recent files,
 *   returning at most `limit` (50) highest-scoring matches.
 */
export function searchQuickOpen(
  candidates: readonly PreparedCandidate[],
  recentFiles: readonly string[],
  rawQuery: string,
  folderRoot: string | null,
  limit = MAX_QUICK_OPEN_RESULTS,
): QuickOpenMatch[] {
  const query = rawQuery.trim();
  if (!query) {
    const count = Math.min(recentFiles.length, MAX_RECENT_FILES, limit);
    const out: QuickOpenMatch[] = [];
    for (let i = 0; i < count; i++) {
      const path = recentFiles[i];
      const { name, dir } = splitPathParts(path, folderRoot);
      out.push({
        path,
        name,
        dir,
        nameMatches: [],
        dirMatches: [],
        score: MAX_RECENT_FILES - i,
        isRecent: true,
      });
    }
    return out;
  }

  const queryLower = query.toLowerCase();
  const queryMask = computeAsciiMask(queryLower);

  const recentRankMap = new Map<string, number>();
  for (let i = 0; i < recentFiles.length && i < MAX_RECENT_FILES; i++) {
    recentRankMap.set(recentFiles[i], i);
  }

  const seenRecent = new Set<string>();
  const top: QuickOpenMatch[] = [];
  let minIdx = -1;
  let minScore = Number.POSITIVE_INFINITY;

  const consider = (match: QuickOpenMatch | null) => {
    if (!match) return;
    if (top.length < limit) {
      top.push(match);
      if (top.length === limit) {
        minIdx = 0;
        minScore = top[0].score;
        for (let i = 1; i < top.length; i++) {
          if (top[i].score < minScore) {
            minScore = top[i].score;
            minIdx = i;
          }
        }
      }
      return;
    }
    if (
      match.score > minScore ||
      (match.score === minScore && compareMatches(match, top[minIdx]) < 0)
    ) {
      top[minIdx] = match;
      minIdx = 0;
      minScore = top[0].score;
      for (let i = 1; i < top.length; i++) {
        if (
          top[i].score < minScore ||
          (top[i].score === minScore && compareMatches(top[i], top[minIdx]) > 0)
        ) {
          minScore = top[i].score;
          minIdx = i;
        }
      }
    }
  };

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const rank = recentRankMap.get(cand.path);
    if (rank !== undefined) seenRecent.add(cand.path);
    consider(
      scoreCandidate(
        cand,
        query,
        queryLower,
        queryMask,
        rank !== undefined ? rank : -1,
      ),
    );
  }

  // Also search recent files outside the currently open folder (or when no folder is open).
  for (let i = 0; i < recentFiles.length && i < MAX_RECENT_FILES; i++) {
    const path = recentFiles[i];
    if (seenRecent.has(path)) continue;
    const cand = prepareSingleCandidate(path, folderRoot);
    consider(scoreCandidate(cand, query, queryLower, queryMask, i));
  }

  top.sort(compareMatches);
  return top;
}
