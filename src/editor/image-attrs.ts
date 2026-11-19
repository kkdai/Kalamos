/**
 * IM-03 / IM-04 helpers (issue #13).
 *
 * - A small, strict parser for a single `<img ...>` tag. User HTML is never
 *   handed to innerHTML: only `src`, `alt`, `title`, `width`, `height` and a
 *   limited `style` (`zoom`, `width`, `height`, `max-width`) are read; every
 *   other attribute / property (`onerror`, `srcset`, `position`, …) is ignored.
 * - Size normalisation shared by the editor widget and PDF export.
 * - `typora-root-url` lookup in a leading `---` front matter block, without
 *   depending on a FrontMatter syntax node.
 */

export interface ImageSize {
  /** CSS length (`120px`, `50%`, `10em`) or undefined. */
  width?: string;
  height?: string;
  maxWidth?: string;
  /** Scale factor (0.5 for `zoom: 50%`), applied to the natural size. */
  zoom?: number;
}

export interface ImgTag {
  src: string;
  alt: string;
  title: string | null;
  size: ImageSize;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the few character references that matter in attribute values. */
export function decodeAttrEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;

/**
 * Parses the attributes of one complete `<img ...>` tag (optionally
 * self-closing). Returns null when `raw` is not exactly one img tag.
 * Duplicate attributes: the first one wins (as in HTML).
 */
export function parseImgAttributes(raw: string): Map<string, string> | null {
  const text = raw.trim();
  const head = /^<img(?=[\s/>])/i.exec(text);
  if (!head) return null;
  const attrs = new Map<string, string>();
  let i = head[0].length;
  const n = text.length;
  for (;;) {
    const ws = /^\s*/.exec(text.slice(i))![0];
    i += ws.length;
    if (i >= n) return null; // unterminated
    if (text[i] === ">") {
      return i === n - 1 ? attrs : null;
    }
    if (text[i] === "/" && text[i + 1] === ">") {
      return i + 1 === n - 1 ? attrs : null;
    }
    if (ws.length === 0 && attrs.size > 0) return null; // attributes must be separated
    const nameMatch = ATTR_NAME.exec(text.slice(i));
    if (!nameMatch) return null;
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    let value = "";
    const eq = /^\s*=\s*/.exec(text.slice(i));
    if (eq) {
      i += eq[0].length;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = text.slice(i + 1, end);
        i = end + 1;
      } else {
        const unquoted = /^[^\s"'=<>`]+/.exec(text.slice(i));
        if (!unquoted) return null;
        value = unquoted[0];
        i += value.length;
        // `<img src=a.png/>`: a trailing `/` right before `>` closes the tag.
        if (value.endsWith("/") && text[i] === ">") {
          value = value.slice(0, -1);
          i -= 1;
        }
      }
    }
    if (!attrs.has(name)) attrs.set(name, decodeAttrEntities(value));
  }
}

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const ATTR_LENGTH = new RegExp(`^(${NUMBER})\\s*(px|%)?$`, "i");
const CSS_LENGTH = new RegExp(`^(${NUMBER})\\s*(px|%|em|rem|vw|vh)?$`, "i");
const MAX_PX = 20_000;

/** `width="120"` / `width="50%"` → CSS length. */
export function normalizeAttrLength(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = ATTR_LENGTH.exec(value.trim());
  if (!m) return undefined;
  const num = Number(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  if (!(num > 0) || (unit === "px" && num > MAX_PX) || (unit === "%" && num > 1000)) {
    return undefined;
  }
  return `${num}${unit}`;
}

function normalizeCssLength(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (v === "auto") return "auto";
  const m = CSS_LENGTH.exec(v);
  if (!m) return undefined;
  const num = Number(m[1]);
  const unit = m[2] ?? (num === 0 ? "px" : undefined);
  if (!unit) return undefined; // unitless lengths are invalid CSS
  if (!(num > 0) || num > MAX_PX) return undefined;
  return `${num}${unit}`;
}

/** `zoom: 50%` / `zoom: 0.5` → 0.5 (bounded to 1%–1000%). */
export function parseZoom(value: string): number | undefined {
  const m = new RegExp(`^(${NUMBER})\\s*(%)?$`).exec(value.trim());
  if (!m) return undefined;
  const factor = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  if (!(factor >= 0.01 && factor <= 10)) return undefined;
  return Math.round(factor * 10_000) / 10_000;
}

/** Reads only zoom / width / height / max-width from an inline style. */
export function parseImageStyle(style: string): ImageSize {
  const size: ImageSize = {};
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl
      .slice(colon + 1)
      .replace(/!important\s*$/i, "")
      .trim();
    if (prop === "zoom") {
      const z = parseZoom(value);
      if (z !== undefined) size.zoom = z;
    } else if (prop === "width" || prop === "height" || prop === "max-width") {
      const len = normalizeCssLength(value);
      if (len === undefined) continue;
      if (prop === "width") size.width = len;
      else if (prop === "height") size.height = len;
      else size.maxWidth = len;
    }
  }
  return size;
}

/** Parses one `<img>` tag; null if it is not a single img tag or has no src. */
export function parseImgTag(raw: string): ImgTag | null {
  const attrs = parseImgAttributes(raw);
  if (!attrs) return null;
  const src = (attrs.get("src") ?? "").trim();
  if (!src) return null;
  // Attribute sizes first; style declarations override them (as in CSS).
  const size: ImageSize = {};
  const w = normalizeAttrLength(attrs.get("width"));
  const h = normalizeAttrLength(attrs.get("height"));
  if (w) size.width = w;
  if (h) size.height = h;
  Object.assign(size, parseImageStyle(attrs.get("style") ?? ""));
  const title = attrs.get("title");
  return {
    src,
    alt: attrs.get("alt") ?? "",
    title: title !== undefined && title !== "" ? title : null,
    size,
  };
}

export function hasImageSize(size: ImageSize | undefined): boolean {
  return Boolean(size && (size.width || size.height || size.maxWidth || size.zoom));
}

/** Stable key for widget equality. */
export function imageSizeKey(size: ImageSize | undefined): string {
  if (!size) return "";
  return [size.width ?? "", size.height ?? "", size.maxWidth ?? "", size.zoom ?? ""].join("|");
}

/** Multiplies a normalised CSS length (`120px`, `50%`) by `factor`. */
export function scaleCssLength(length: string, factor: number): string {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([a-z%]+)$/.exec(length);
  if (!m) return length;
  return `${Math.round(Number(m[1]) * factor * 100) / 100}${m[2]}`;
}

/**
 * Resolves zoom against explicit sizes: with a width / height, zoom scales
 * those lengths; without one, zoom is kept (it needs the natural size).
 */
export function resolveZoomedSize(size: ImageSize): ImageSize {
  if (size.zoom === undefined || (!size.width && !size.height)) return size;
  const out: ImageSize = { ...size };
  delete out.zoom;
  if (size.width && size.width !== "auto") out.width = scaleCssLength(size.width, size.zoom);
  if (size.height && size.height !== "auto") out.height = scaleCssLength(size.height, size.zoom);
  return out;
}

/**
 * CSS declarations for export (where there is no load event): explicit sizes
 * plus CSS `zoom`, which Chromium and WebKit print correctly. Only values that
 * passed the normalisers above ever reach this string.
 */
export function imageSizeCss(input: ImageSize | undefined): string {
  if (!input) return "";
  const size = resolveZoomedSize(input);
  const parts: string[] = [];
  if (size.width) parts.push(`width:${size.width}`);
  if (size.height) parts.push(`height:${size.height}`);
  if (size.maxWidth) parts.push(`max-width:${size.maxWidth}`);
  if (size.zoom !== undefined) parts.push(`zoom:${size.zoom}`);
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// Front matter: typora-root-url
// ---------------------------------------------------------------------------

const FRONT_MATTER_MAX_LINES = 200;

function unquoteYamlScalar(value: string): string {
  const v = value.trim();
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const end = v.indexOf(quote, 1);
    return end > 0 ? v.slice(1, end).trim() : "";
  }
  // Strip a trailing comment (` # ...`) on unquoted scalars.
  return v.replace(/\s+#.*$/, "").trim();
}

/**
 * `typora-root-url` from a front matter block that starts on the very first
 * line (`---`) and ends with `---` or `...`. `getLine(i)` returns line i
 * (0-based) or undefined past the end, so callers can avoid slicing the whole
 * document.
 */
export function findTyporaRootUrl(getLine: (index: number) => string | undefined): string | null {
  if (getLine(0)?.replace(/\s+$/, "") !== "---") return null;
  for (let i = 1; i < FRONT_MATTER_MAX_LINES; i++) {
    const line = getLine(i);
    if (line === undefined) return null; // never closed: not front matter
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === "---" || trimmed === "...") return null;
    const m = /^typora-root-url\s*:(.*)$/.exec(trimmed);
    if (m) {
      // Only valid when the block is actually closed.
      for (let j = i + 1; j < FRONT_MATTER_MAX_LINES; j++) {
        const rest = getLine(j);
        if (rest === undefined) return null;
        const t = rest.replace(/\s+$/, "");
        if (t === "---" || t === "...") break;
        if (j === FRONT_MATTER_MAX_LINES - 1) return null;
      }
      const value = unquoteYamlScalar(m[1]);
      return value || null;
    }
  }
  return null;
}

export function findTyporaRootUrlInText(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const lines = text.split(/\r?\n/, FRONT_MATTER_MAX_LINES);
  return findTyporaRootUrl((i) => lines[i]);
}
