import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SUMMARY_PLACEHOLDER,
  extractChangelogSection,
  formatReleaseNotes,
} from "../scripts/generate-release-notes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "../scripts/generate-release-notes.mjs");

const SAMPLE_CHECKSUMS = [
  "aaaa  Kalamos_0.4.0_aarch64.dmg",
  "bbbb  Kalamos_0.4.0_x64.dmg",
  "cccc  Kalamos_0.4.0_x64-setup.exe",
  "dddd  Kalamos_0.4.0_x64_en-US.msi",
].join("\n");

const SAMPLE_CHANGELOG = [
  "# kalamos",
  "",
  "## 0.5.0-rc.1",
  "",
  "### Minor Changes",
  "",
  "- Prerelease feature",
  "",
  "## 0.4.0",
  "",
  "### Minor Changes",
  "",
  "- Windows support",
  "- Automated release workflow",
  "",
  "## 0.3.0",
  "",
  "### Minor Changes",
  "",
  "- Multi-document tabs",
  "",
].join("\n");

describe("extractChangelogSection", () => {
  it("extracts the matching ## <version> section without bleeding into adjacent versions", () => {
    const section = extractChangelogSection(SAMPLE_CHANGELOG, "0.4.0");
    assert.equal(
      section,
      [
        "### Minor Changes",
        "",
        "- Windows support",
        "- Automated release workflow",
      ].join("\n"),
    );
  });

  it("extracts the last section in the changelog", () => {
    const section = extractChangelogSection(SAMPLE_CHANGELOG, "0.3.0");
    assert.equal(
      section,
      ["### Minor Changes", "", "- Multi-document tabs"].join("\n"),
    );
  });

  it("matches prerelease versions and does not confuse them with base versions", () => {
    assert.equal(
      extractChangelogSection(SAMPLE_CHANGELOG, "0.5.0-rc.1"),
      ["### Minor Changes", "", "- Prerelease feature"].join("\n"),
    );
    assert.equal(extractChangelogSection(SAMPLE_CHANGELOG, "0.5.0"), "");
  });

  it("supports CRLF line endings", () => {
    const crlfChangelog = SAMPLE_CHANGELOG.replace(/\n/g, "\r\n");
    const section = extractChangelogSection(crlfChangelog, "0.4.0");
    assert.equal(
      section,
      [
        "### Minor Changes",
        "",
        "- Windows support",
        "- Automated release workflow",
      ].join("\n"),
    );
  });

  it("does not terminate a section early on ## lines inside fenced code blocks", () => {
    const changelog = [
      "# kalamos",
      "",
      "## 0.4.1",
      "",
      "### Patch Changes",
      "",
      "- Example heading:",
      "```markdown",
      "## Not a version heading",
      "```",
      "- Follow-up note",
      "",
      "## 0.4.0",
      "",
      "- Older release",
    ].join("\n");

    const section = extractChangelogSection(changelog, "0.4.1");
    assert.match(section, /## Not a version heading/);
    assert.match(section, /- Follow-up note/);
    assert.doesNotMatch(section, /Older release/);
  });

  it("returns an empty string when the version is absent or empty", () => {
    assert.equal(extractChangelogSection(SAMPLE_CHANGELOG, "9.9.9"), "");
    assert.equal(
      extractChangelogSection("# kalamos\n\n## 0.4.0\n\n## 0.3.0\n", "0.4.0"),
      "",
    );
    assert.equal(extractChangelogSection("", "0.4.0"), "");
  });
});

describe("formatReleaseNotes", () => {
  it("fills the summary slot from CHANGELOG.md when a matching section exists", () => {
    const notes = formatReleaseNotes({
      version: "0.4.0",
      checksumsText: SAMPLE_CHECKSUMS,
      changelogText: SAMPLE_CHANGELOG,
    });

    assert.match(
      notes,
      /## Kalamos v0\.4\.0\n\n### Minor Changes\n\n- Windows support/,
    );
    assert.doesNotMatch(notes, /發布前請在此補充/);
    assert.doesNotMatch(notes, /Multi-document tabs/);
    assert.match(notes, /### 安裝方式/);
  });

  it("retains the placeholder when no matching changelog section exists", () => {
    const notesMissing = formatReleaseNotes({
      version: "0.4.0",
      checksumsText: SAMPLE_CHECKSUMS,
      changelogText: "# kalamos\n\n## 0.3.0\n\n- Older\n",
    });
    assert.ok(notesMissing.includes(DEFAULT_SUMMARY_PLACEHOLDER));

    const notesDefault = formatReleaseNotes({
      version: "0.4.0",
      checksumsText: SAMPLE_CHECKSUMS,
    });
    assert.ok(notesDefault.includes(DEFAULT_SUMMARY_PLACEHOLDER));
  });
});

describe("generate-release-notes CLI", () => {
  it("reads CHANGELOG.md from cwd automatically and falls back to placeholder if absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalamos-notes-"));
    try {
      const checksumsPath = join(dir, "SHA256SUMS.txt");
      const outputPath = join(dir, "release-notes.md");
      writeFileSync(checksumsPath, SAMPLE_CHECKSUMS, "utf8");

      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--version",
          "0.4.0",
          "--checksums",
          checksumsPath,
          "--output",
          outputPath,
        ],
        { cwd: dir },
      );
      const withoutChangelog = readFileSync(outputPath, "utf8");
      assert.ok(withoutChangelog.includes(DEFAULT_SUMMARY_PLACEHOLDER));

      writeFileSync(join(dir, "CHANGELOG.md"), SAMPLE_CHANGELOG, "utf8");
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          "--version",
          "0.4.0",
          "--checksums",
          checksumsPath,
          "--output",
          outputPath,
        ],
        { cwd: dir },
      );
      const withChangelog = readFileSync(outputPath, "utf8");
      assert.match(withChangelog, /- Windows support/);
      assert.doesNotMatch(withChangelog, /發布前請在此補充/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
