/**
 * EX-01 print stylesheet (inlined into the exported HTML).
 * Kept as a TS string so vitest sees the real CSS (vitest stubs CSS imports).
 */
export const PRINT_CSS = `/*
 * EX-01 print stylesheet for PDF export (Papyros palette on white paper).
 * Page geometry must match src-tauri/src/export.rs (A4, 18mm top/bottom,
 * 20mm left/right; no header/footer).
 */
@page {
  size: A4;
  margin: 18mm 20mm;
}

:root {
  --k-text: #2b2622;
  --k-text-muted: #6e6355;
  --k-accent: #5e7a4a;
  --k-link: #a4552f;
  --k-divider: #d9cdb3;
  --k-surface: #f7f3ea;
  --k-syntax-keyword: #a4552f;
  --k-syntax-string: #5e7a4a;
  --k-syntax-comment: #6e6355;
  --k-syntax-number: #8a4b2d;
  --k-syntax-function: #50613f;
  --k-syntax-type: #82673b;
  --k-syntax-operator: #5f564b;
  --k-syntax-property: #4d3f35;
}

html,
body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: var(--k-text);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.k-export {
  font-family: "Source Serif 4", "Songti TC", "Noto Serif TC", Georgia, serif;
  font-size: 11pt;
  line-height: 1.7;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  font-family: Inter, "PingFang TC", "Noto Sans TC", "Helvetica Neue", sans-serif;
  line-height: 1.35;
  margin: 1.4em 0 0.5em;
  break-after: avoid;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
}

h1 { font-size: 20pt; }
h2 { font-size: 16pt; border-bottom: 1px solid var(--k-divider); padding-bottom: 0.2em; }
h3 { font-size: 13.5pt; }
h4 { font-size: 12pt; }
h5 { font-size: 11pt; }
h6 { font-size: 11pt; color: var(--k-text-muted); }

.k-export > :first-child { margin-top: 0; }

p { margin: 0.6em 0; orphans: 3; widows: 3; }

a { color: var(--k-link); text-decoration: none; }

blockquote {
  margin: 0.8em 0;
  padding: 0.1em 1em;
  border-left: 3px solid var(--k-divider);
  color: var(--k-text-muted);
}

ul,
ol { margin: 0.5em 0; padding-left: 1.6em; }
li > p { margin: 0.2em 0; }
li.k-task { list-style: none; margin-left: -1.3em; }

.k-task-box {
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  margin-right: 0.45em;
  border: 1px solid var(--k-text-muted);
  border-radius: 2px;
  font-size: 0.85em;
  line-height: 0.85em;
  text-align: center;
  vertical-align: -0.05em;
}

.k-task-box[data-checked="true"] {
  background: var(--k-accent);
  border-color: var(--k-accent);
  color: #fff;
}

code,
pre {
  font-family: "JetBrains Mono", Menlo, "SF Mono", monospace;
  font-size: 9pt;
}

:not(pre) > code {
  background: var(--k-surface);
  border-radius: 3px;
  padding: 0.1em 0.3em;
}

pre {
  background: var(--k-surface);
  border: 1px solid var(--k-divider);
  border-radius: 4px;
  padding: 0.7em 0.9em;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  break-inside: avoid;
  page-break-inside: avoid;
}

pre.k-raw-html { color: var(--k-text-muted); }

.k-tok-keyword { color: var(--k-syntax-keyword); font-weight: 600; }
.k-tok-string { color: var(--k-syntax-string); }
.k-tok-comment { color: var(--k-syntax-comment); font-style: italic; }
.k-tok-number { color: var(--k-syntax-number); }
.k-tok-function { color: var(--k-syntax-function); }
.k-tok-type { color: var(--k-syntax-type); }
.k-tok-operator { color: var(--k-syntax-operator); }
.k-tok-property { color: var(--k-syntax-property); }

table.k-table {
  border-collapse: collapse;
  margin: 0.8em 0;
  max-width: 100%;
  break-inside: avoid;
  page-break-inside: avoid;
}

table.k-table th,
table.k-table td {
  border: 1px solid var(--k-divider);
  padding: 0.3em 0.6em;
  vertical-align: top;
}

table.k-table thead th { background: var(--k-surface); }
tr { break-inside: avoid; page-break-inside: avoid; }

hr { border: 0; border-top: 1px solid var(--k-divider); margin: 1.4em 0; }

img { max-width: 100%; break-inside: avoid; page-break-inside: avoid; }
.k-image-missing { color: var(--k-text-muted); font-style: italic; }

.k-math-block {
  margin: 0.8em 0;
  text-align: center;
  break-inside: avoid;
  page-break-inside: avoid;
}

.k-math-block svg { max-width: 100%; }
.k-math-error { color: var(--k-link); }

sup.k-fn-ref { font-size: 0.75em; line-height: 0; }
sup.k-fn-ref a::before { content: "["; }
sup.k-fn-ref a::after { content: "]"; }

.k-footnotes { margin-top: 2em; font-size: 9.5pt; color: var(--k-text-muted); }
.k-footnotes hr { margin: 0 0 0.8em; width: 30%; }
.k-footnotes ol { padding-left: 1.4em; }
.k-fn-back { margin-left: 0.3em; }

nav.k-toc { margin: 0.8em 0 1.2em; padding: 0.4em 1em; border-left: 3px solid var(--k-accent); }
nav.k-toc ul { list-style: none; margin: 0; padding-left: 1.2em; }
nav.k-toc > ul { padding-left: 0; }
nav.k-toc li { margin: 0.15em 0; }
`;
