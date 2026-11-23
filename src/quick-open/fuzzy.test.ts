import { describe, expect, it } from "vitest";
import {
  MAX_QUICK_OPEN_RESULTS,
  prepareCandidates,
  searchQuickOpen,
} from "./fuzzy";

describe("#104 Quick Open fuzzy matcher", () => {
  const root = "/tmp/kalamos-test/vault";

  it("returns up to 20 recent files newest-first when query is empty (even outside folder)", () => {
    const recents = Array.from(
      { length: 25 },
      (_, i) => `/tmp/kalamos-test/other/doc-${i}.md`,
    );
    const matches = searchQuickOpen([], recents, "   ", root);
    expect(matches).toHaveLength(20);
    expect(matches[0].path).toBe("/tmp/kalamos-test/other/doc-0.md");
    expect(matches[0].name).toBe("doc-0.md");
    expect(matches[0].dir).toBe("/tmp/kalamos-test/other");
    expect(matches[0].isRecent).toBe(true);
    expect(matches[19].path).toBe("/tmp/kalamos-test/other/doc-19.md");
  });

  it("prefers filename matches over path-only matches", () => {
    const paths = [
      `${root}/read/deep/notes.md`,
      `${root}/docs/README.md`,
      `${root}/readme-guide/index.md`,
    ];
    const cands = prepareCandidates(paths, root);
    const results = searchQuickOpen(cands, [], "readme", root);
    expect(results[0].path).toBe(`${root}/docs/README.md`);
    expect(results[0].nameMatches).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results[0].dirMatches).toEqual([]);
  });

  it("rewards consecutive matches, prefixes, and word/segment boundaries", () => {
    const paths = [
      `${root}/g_u_i_d_e.md`,
      `${root}/my-guide.md`,
      `${root}/guide.md`,
      `${root}/sub/quick-open.md`,
      `${root}/sub/quote.md`,
    ];
    const cands = prepareCandidates(paths, root);

    const guideResults = searchQuickOpen(cands, [], "guide", root);
    expect(guideResults.map((r) => r.name)).toEqual([
      "guide.md",
      "my-guide.md",
      "g_u_i_d_e.md",
    ]);

    // Acronym "qo": 'q' at start + 'o' after '-' boundary beats 'o' mid-word in quote.md.
    const qoResults = searchQuickOpen(cands, [], "qo", root);
    expect(qoResults[0].name).toBe("quick-open.md");
    expect(qoResults[0].nameMatches).toEqual([0, 6]);
  });

  it("matches across directory segments and highlights both dir and name", () => {
    const paths = [`${root}/guides/shortcuts.md`, `${root}/archive/notes.md`];
    const cands = prepareCandidates(paths, root);
    const results = searchQuickOpen(cands, [], "gshort", root);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(`${root}/guides/shortcuts.md`);
    expect(results[0].dir).toBe("guides");
    expect(results[0].dirMatches).toEqual([0]); // 'g' in "guides"
    expect(results[0].nameMatches).toEqual([0, 1, 2, 3, 4]); // "short" in "shortcuts.md"
  });

  it("boosts recently opened files when searching", () => {
    const paths = [`${root}/alpha/notes.md`, `${root}/beta/notes.md`];
    const cands = prepareCandidates(paths, root);
    const results = searchQuickOpen(
      cands,
      [`${root}/beta/notes.md`],
      "notes",
      root,
    );
    expect(results[0].path).toBe(`${root}/beta/notes.md`);
    expect(results[0].isRecent).toBe(true);
    expect(results[1].path).toBe(`${root}/alpha/notes.md`);
    expect(results[1].isRecent).toBe(false);
  });

  it("matches CJK filenames and highlights matched characters", () => {
    const paths = [
      `${root}/設計規格.md`,
      `${root}/日記/設計筆記.md`,
      `${root}/隨筆.md`,
    ];
    const cands = prepareCandidates(paths, root);
    const results = searchQuickOpen(cands, [], "設筆", root);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("設計筆記.md");
    expect(results[0].nameMatches).toEqual([0, 2]);
  });

  it("caps results at MAX_QUICK_OPEN_RESULTS (50)", () => {
    const paths = Array.from(
      { length: 120 },
      (_, i) => `${root}/note-${String(i).padStart(3, "0")}.md`,
    );
    const cands = prepareCandidates(paths, root);
    const results = searchQuickOpen(cands, [], "note", root);
    expect(results).toHaveLength(MAX_QUICK_OPEN_RESULTS);
  });

  it("searches 10,000 files well within 16ms per keystroke", () => {
    const dirs = [
      "docs",
      "guides",
      "journal",
      "projects/alpha",
      "projects/beta",
    ];
    const paths = Array.from({ length: 10_000 }, (_, i) => {
      const dir = dirs[i % dirs.length];
      return `${root}/${dir}/article-${String(i).padStart(5, "0")}.md`;
    });
    paths[7777] = `${root}/guides/quick-open-spec.md`;
    const cands = prepareCandidates(paths, root);
    const recent = [`${root}/docs/article-00010.md`];

    // Warm up JIT once
    searchQuickOpen(cands, recent, "qosp", root);

    const queries = ["qosp", "art77", "guides/art", "a"];
    for (const q of queries) {
      const start = performance.now();
      const res = searchQuickOpen(cands, recent, q, root);
      const elapsed = performance.now() - start;
      expect(res.length).toBeGreaterThan(0);
      expect(res.length).toBeLessThanOrEqual(MAX_QUICK_OPEN_RESULTS);
      // Generous upper guard for slow CI VMs; typically < 5ms locally.
      expect(elapsed).toBeLessThan(80);
    }

    const specStart = performance.now();
    const specRes = searchQuickOpen(cands, recent, "qosp", root);
    const specElapsed = performance.now() - specStart;
    expect(specRes[0].path).toBe(`${root}/guides/quick-open-spec.md`);
    expect(specElapsed).toBeLessThan(16);
  });
});
