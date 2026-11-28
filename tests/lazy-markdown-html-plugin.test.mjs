import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLazyMarkdownHtmlPlugin,
  LANG_MARKDOWN_SUFFIX,
  LANGUAGE_DATA_SUFFIX,
} from "../scripts/lazy-markdown-html-plugin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_LANG_PATH = "/repo/src/editor/markdown-lang.ts";

const VALID_LANGUAGE_DATA = `
const languages = [
  LanguageDescription.of({
    name: "Markdown",
    load() {
      return import('@codemirror/lang-markdown').then(m => m.markdown());
    }
  })
];
`;

const VALID_LANG_MARKDOWN = `
import { html, htmlCompletionSource } from '@codemirror/lang-html';
export const markdownLanguage = {};
`;

function createMockContext() {
  return {
    error(message) {
      throw new Error(message);
    },
  };
}

describe("kalamos-lazy-markdown-html plugin (#146)", () => {
  it("rewrites both targets and succeeds in buildEnd when both match", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    plugin.buildStart();
    const ldRes = plugin.transform(
      VALID_LANGUAGE_DATA,
      `/project${LANGUAGE_DATA_SUFFIX}`,
    );
    const lmRes = plugin.transform(
      VALID_LANG_MARKDOWN,
      `C:\\project${LANG_MARKDOWN_SUFFIX.replace(/\//g, "\\")}`,
    );

    assert.ok(
      ldRes,
      "expected language-data transform to return rewritten code",
    );
    assert.match(
      ldRes.code,
      /import\("\/repo\/src\/editor\/markdown-lang\.ts"\)\.then\(\(m\) => m\.createMarkdownSupport\(\{ pasteURLAsLink: false \}\)\)/,
    );
    assert.ok(
      lmRes,
      "expected lang-markdown transform to return rewritten code",
    );
    assert.doesNotMatch(lmRes.code, /@codemirror\/lang-html/);
    assert.match(lmRes.code, /Use createMarkdownSupport\(\) instead/);

    // Ignores unrelated modules.
    assert.equal(
      plugin.transform("export const x = 1;", "/project/src/other.ts"),
      null,
    );

    assert.doesNotThrow(() => plugin.buildEnd.call(ctx));
  });

  it("fails buildEnd when only language-data matches and lang-markdown pattern drifts", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    plugin.buildStart();
    assert.ok(
      plugin.transform(VALID_LANGUAGE_DATA, `/project${LANGUAGE_DATA_SUFFIX}`),
    );
    assert.equal(
      plugin.transform(
        "import { html } from '@codemirror/lang-html';\n",
        `/project${LANG_MARKDOWN_SUFFIX}`,
      ),
      null,
    );

    assert.throws(
      () => plugin.buildEnd.call(ctx),
      /kalamos-lazy-markdown-html.*language-data: matched.*lang-markdown: file seen but pattern did not match/,
    );
  });

  it("fails buildEnd when only lang-markdown matches and language-data pattern drifts", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    plugin.buildStart();
    assert.equal(
      plugin.transform(
        "return import('@codemirror/lang-markdown').then(m => m.commonmark());",
        `/project${LANGUAGE_DATA_SUFFIX}`,
      ),
      null,
    );
    assert.ok(
      plugin.transform(VALID_LANG_MARKDOWN, `/project${LANG_MARKDOWN_SUFFIX}`),
    );

    assert.throws(
      () => plugin.buildEnd.call(ctx),
      /kalamos-lazy-markdown-html.*language-data: file seen but pattern did not match.*lang-markdown: matched/,
    );
  });

  it("fails buildEnd when only one target file is ever seen", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    plugin.buildStart();
    assert.ok(
      plugin.transform(VALID_LANGUAGE_DATA, `/project${LANGUAGE_DATA_SUFFIX}`),
    );

    assert.throws(
      () => plugin.buildEnd.call(ctx),
      /kalamos-lazy-markdown-html.*language-data: matched.*lang-markdown: target file not seen/,
    );
  });

  it("fails buildEnd when neither target file is seen, and resets across buildStart", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    // First build succeeds.
    plugin.buildStart();
    plugin.transform(VALID_LANGUAGE_DATA, `/project${LANGUAGE_DATA_SUFFIX}`);
    plugin.transform(VALID_LANG_MARKDOWN, `/project${LANG_MARKDOWN_SUFFIX}`);
    assert.doesNotThrow(() => plugin.buildEnd.call(ctx));

    // Second build sees neither file and must fail (state was reset).
    plugin.buildStart();
    assert.throws(
      () => plugin.buildEnd.call(ctx),
      /kalamos-lazy-markdown-html.*language-data: target file not seen.*lang-markdown: target file not seen/,
    );
  });

  it("does not mask an earlier Rollup build error in buildEnd", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();

    plugin.buildStart();
    assert.doesNotThrow(() =>
      plugin.buildEnd.call(ctx, new Error("upstream build failure")),
    );
  });

  it("matches the currently installed @codemirror/language-data and @codemirror/lang-markdown files", () => {
    const plugin = createLazyMarkdownHtmlPlugin(MARKDOWN_LANG_PATH);
    const ctx = createMockContext();
    const ldPath = resolve(REPO_ROOT, LANGUAGE_DATA_SUFFIX.slice(1));
    const lmPath = resolve(REPO_ROOT, LANG_MARKDOWN_SUFFIX.slice(1));

    plugin.buildStart();
    const ldRes = plugin.transform(readFileSync(ldPath, "utf8"), ldPath);
    const lmRes = plugin.transform(readFileSync(lmPath, "utf8"), lmPath);

    assert.ok(ldRes, "installed @codemirror/language-data should match");
    assert.ok(lmRes, "installed @codemirror/lang-markdown should match");
    assert.doesNotThrow(() => plugin.buildEnd.call(ctx));
  });
});
