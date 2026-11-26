import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES_DIR = resolve(ROOT_DIR, "src/styles/themes");

function readThemeCss(filename) {
  return readFileSync(resolve(THEMES_DIR, filename), "utf8");
}

function extractRuleBody(css, marker) {
  const idx = css.indexOf(marker);
  assert.notEqual(idx, -1, `Rule marker not found: ${marker}`);
  const openBrace = css.indexOf("{", idx);
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return css.slice(openBrace + 1, i);
      }
    }
  }
  assert.fail(`Unclosed rule body for: ${marker}`);
}

function extractTokens(ruleBody) {
  const tokens = {};
  for (const match of ruleBody.matchAll(/(--k-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return tokens;
}

function relativeLuminance(hex) {
  const clean = hex.trim().replace(/^#/, "");
  assert.match(clean, /^[0-9a-f]{6}$/i, `Expected 6-digit hex, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = Number.parseInt(clean.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test("nyx.css defines color-scheme: dark and every token defined in melan.css", () => {
  const melanCss = readThemeCss("melan.css");
  const nyxCss = readThemeCss("nyx.css");

  const melanTokens = extractTokens(
    extractRuleBody(melanCss, ':root[data-theme="melan"]'),
  );
  const nyxBody = extractRuleBody(nyxCss, ':root[data-theme="nyx"]');
  const nyxTokens = extractTokens(nyxBody);
  const nyxSystemDarkBody = extractRuleBody(
    nyxCss,
    ':root:not([data-theme])[data-system-dark-theme="nyx"]',
  );
  const nyxSystemDarkTokens = extractTokens(nyxSystemDarkBody);

  assert.match(nyxBody, /color-scheme\s*:\s*dark\s*;/);
  assert.match(nyxSystemDarkBody, /color-scheme\s*:\s*dark\s*;/);

  for (const token of Object.keys(melanTokens)) {
    assert.ok(nyxTokens[token], `Missing ${token} in [data-theme="nyx"]`);
    assert.equal(
      nyxSystemDarkTokens[token],
      nyxTokens[token],
      `Mismatch for ${token} in system-dark nyx rule`,
    );
  }
});

test("nyx.css meets WCAG AA (>= 4.5:1) contrast on both --k-bg and --k-surface", () => {
  const nyxCss = readThemeCss("nyx.css");
  const nyxTokens = extractTokens(
    extractRuleBody(nyxCss, ':root[data-theme="nyx"]'),
  );

  const bg = nyxTokens["--k-bg"];
  const surface = nyxTokens["--k-surface"];
  const foregrounds = [
    ["--k-text", nyxTokens["--k-text"]],
    ["--k-text-muted", nyxTokens["--k-text-muted"]],
    ["--k-link", nyxTokens["--k-link"]],
    ["--k-accent", nyxTokens["--k-accent"]],
    ["--k-danger", nyxTokens["--k-danger"]],
  ];

  for (const [name, color] of foregrounds) {
    const onBg = contrastRatio(color, bg);
    const onSurface = contrastRatio(color, surface);
    assert.ok(
      onBg >= 4.5,
      `${name} (${color}) on --k-bg (${bg}) contrast ${onBg.toFixed(2)}:1 < 4.5:1`,
    );
    assert.ok(
      onSurface >= 4.5,
      `${name} (${color}) on --k-surface (${surface}) contrast ${onSurface.toFixed(2)}:1 < 4.5:1`,
    );
  }

  const accentTextOnAccent = contrastRatio(
    nyxTokens["--k-accent-text"],
    nyxTokens["--k-accent"],
  );
  assert.ok(
    accentTextOnAccent >= 4.5,
    `--k-accent-text on --k-accent contrast ${accentTextOnAccent.toFixed(2)}:1 < 4.5:1`,
  );
});
