export const LANGUAGE_DATA_SUFFIX =
  "/node_modules/@codemirror/language-data/dist/index.js";
export const LANG_MARKDOWN_SUFFIX =
  "/node_modules/@codemirror/lang-markdown/dist/index.js";

const LANGUAGE_DATA_RE =
  /import\(['"]@codemirror\/lang-markdown['"]\)\.then\((\w+)\s*=>\s*\1\.markdown\(\)\)/;
const LANG_MARKDOWN_RE =
  /import\s*\{\s*html\s*,\s*htmlCompletionSource\s*\}\s*from\s*['"]@codemirror\/lang-html['"];?/;

function formatTargetStatus(seen, patched) {
  if (patched) return "matched";
  if (seen) return "file seen but pattern did not match";
  return "target file not seen";
}

/**
 * Production-only Vite/Rollup plugin that keeps `@codemirror/lang-html` (and
 * its transitive `@lezer/html`, `@lezer/css`, `@lezer/javascript` grammar
 * tables — ~141 KiB minified) out of the initial startup bundle.
 *
 * Why both rewrites are strictly coupled:
 * - `@codemirror/lang-markdown`'s `markdown()` statically imports
 *   `@codemirror/lang-html`. Even though Kalamos uses `createMarkdownSupport()`
 *   instead of `markdown()`, `@codemirror/language-data` dynamically calls
 *   `import('@codemirror/lang-markdown').then(m => m.markdown())` for fenced
 *   `markdown` blocks, which keeps `markdown()` and its static `lang-html` edge
 *   in the startup chunk.
 * - Because we replace `html` in `@codemirror/lang-markdown` with a throwing
 *   stub, `@codemirror/language-data`'s Markdown entry MUST be redirected to
 *   `createMarkdownSupport()` at the same time — otherwise rendering a
 *   ```` ```markdown ```` code block would throw at runtime.
 * - `buildEnd` enforces that BOTH targets matched and fails the build via
 *   `this.error()` if either package drifted.
 *
 * Checklist when upgrading `@codemirror/lang-markdown` or
 * `@codemirror/language-data`:
 * 1. Verify both entry paths (`LANGUAGE_DATA_SUFFIX`, `LANG_MARKDOWN_SUFFIX`)
 *    still match the installed package layout.
 * 2. Verify `@codemirror/language-data`'s Markdown entry still matches
 *    `LANGUAGE_DATA_RE` (`import('@codemirror/lang-markdown').then(m => m.markdown())`).
 * 3. Verify `@codemirror/lang-markdown`'s static `@codemirror/lang-html` import
 *    still matches `LANG_MARKDOWN_RE`, and confirm none of the exports Kalamos
 *    uses (`markdownLanguage`, `pasteURLAsLink`, `deleteMarkupBackward`,
 *    `insertNewlineContinueMarkupCommand`) reference `html` or
 *    `htmlCompletionSource`.
 * 4. If upstream `@codemirror/lang-markdown` ever drops its static `lang-html`
 *    dependency, this plugin can be removed.
 *
 * @param {string} markdownLangPath Normalized absolute path to `src/editor/markdown-lang.ts`.
 */
export function createLazyMarkdownHtmlPlugin(markdownLangPath) {
  let seenLanguageData = false;
  let patchedLanguageData = false;
  let seenLangMarkdown = false;
  let patchedLangMarkdown = false;

  return {
    name: "kalamos-lazy-markdown-html",
    apply: "build",

    buildStart() {
      seenLanguageData = false;
      patchedLanguageData = false;
      seenLangMarkdown = false;
      patchedLangMarkdown = false;
    },

    transform(code, id) {
      const norm = id.replace(/\\/g, "/");
      if (norm.endsWith(LANGUAGE_DATA_SUFFIX)) {
        seenLanguageData = true;
        const replaced = code.replace(
          LANGUAGE_DATA_RE,
          `import(${JSON.stringify(markdownLangPath)}).then((m) => m.createMarkdownSupport({ pasteURLAsLink: false }))`,
        );
        if (replaced !== code) {
          patchedLanguageData = true;
          return { code: replaced, map: null };
        }
        return null;
      }
      if (norm.endsWith(LANG_MARKDOWN_SUFFIX)) {
        seenLangMarkdown = true;
        const replaced = code.replace(
          LANG_MARKDOWN_RE,
          `const html = () => { throw new Error("Use createMarkdownSupport() instead of markdown()"); }; const htmlCompletionSource = () => null;`,
        );
        if (replaced !== code) {
          patchedLangMarkdown = true;
          return { code: replaced, map: null };
        }
        return null;
      }
      return null;
    },

    buildEnd(error) {
      if (error) return;
      if (!patchedLanguageData || !patchedLangMarkdown) {
        const ldStatus = formatTargetStatus(
          seenLanguageData,
          patchedLanguageData,
        );
        const lmStatus = formatTargetStatus(
          seenLangMarkdown,
          patchedLangMarkdown,
        );
        this.error(
          `[kalamos-lazy-markdown-html] @codemirror/lang-markdown / @codemirror/language-data 版本已變動，請更新 kalamos-lazy-markdown-html（language-data: ${ldStatus}；lang-markdown: ${lmStatus}）。`,
        );
      }
    },
  };
}
