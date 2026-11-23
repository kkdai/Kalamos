import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import {
  findTyporaRootUrlInText,
  parseImgTag,
} from "../../src/editor/image-attrs.ts";
import type { AssetInput } from "../shared/api.ts";
import { asset, base64, HttpError, isObject, workspacePath } from "./input.ts";

const exec = promisify(execFile);
const mib = 1024 * 1024;
const markdownReader =
  "markdown+tex_math_dollars+footnotes+yaml_metadata_block+pipe_tables+task_lists";
const markdownWriter = "gfm-tex_math_gfm+tex_math_dollars+footnotes";
const exportFormats = new Map([
  ["docx", "docx"],
  ["odt", "odt"],
  ["latex", "latex"],
  ["mediawiki", "mediawiki"],
  ["epub", "epub3"],
]);
const importFormats = new Map([
  [".docx", "docx"],
  [".odt", "odt"],
  [".epub", "epub"],
  [".tex", "latex"],
  [".latex", "latex"],
  [".html", "html"],
  [".htm", "html"],
  [".wiki", "mediawiki"],
  [".mediawiki", "mediawiki"],
]);
const imageTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);

export { HttpError as ConversionError };

type FindAttachment = (
  path: string,
) => Promise<{ mime: string; data: Uint8Array } | null | undefined>;

async function inPrivateDirectory<T>(
  convert: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "kalamos-convert-"));
  try {
    return await convert(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Do not pass app credentials or the user's Pandoc configuration to the tools.
function childEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8",
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
  };
}

async function run(
  tool: "Pandoc" | "Image uploader",
  executable: string,
  args: string[],
  directory: string,
): Promise<Buffer> {
  try {
    const { stdout } = await exec(executable, args, {
      cwd: directory,
      env: childEnvironment(directory),
      encoding: "buffer",
      shell: false,
      windowsHide: true,
      timeout: tool === "Pandoc" ? 60_000 : 30_000,
      killSignal: "SIGKILL",
      maxBuffer: tool === "Pandoc" ? 32 * mib : 8192,
    });
    return stdout;
  } catch (error) {
    const code = isObject(error) ? error.code : null;
    if (code === "ENOENT" || code === "EACCES")
      throw new HttpError(
        503,
        `${tool} is unavailable. Check the server executable setting.`,
      );
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new HttpError(413, `${tool} output exceeds the size limit.`);
    if (isObject(error) && error.killed)
      throw new HttpError(504, `${tool} timed out.`);
    if (tool === "Pandoc" && isObject(error) && Buffer.isBuffer(error.stderr)) {
      const stderr = error.stderr.toString();
      // Some distribution builds keep the standard templates outside the binary.
      if (
        /Could not find data file|unrecognized option.*--sandbox/i.test(stderr)
      ) {
        throw new HttpError(
          503,
          "Install an official Pandoc build with built-in data files and --sandbox support.",
        );
      }
    }
    throw new HttpError(
      tool === "Pandoc" ? 422 : 502,
      `${tool} failed. Check the file format or server tool setup.`,
    );
  }
}

const pdfUrl = "https://kalamos-export.invalid/document";
const pdfPolicy =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

async function renderPdf(html: string): Promise<Buffer> {
  return inPrivateDirectory(async (directory) => {
    const executablePath = process.env.KALAMOS_CHROMIUM || undefined;
    const browser = await chromium
      .launch({
        executablePath,
        env: childEnvironment(directory),
        headless: true,
        chromiumSandbox: true,
        timeout: 15_000,
        args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
      })
      .catch(() => {
        throw new HttpError(
          503,
          "Chromium could not start. Install Chromium, set KALAMOS_CHROMIUM if needed, and check browser sandbox support.",
        );
      });
    try {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: "block",
        offline: true,
        acceptDownloads: false,
      });
      await context.route("**/*", (route) => {
        const request = route.request();
        if (
          request.url() !== pdfUrl ||
          request.method() !== "GET" ||
          request.resourceType() !== "document"
        ) {
          return route.abort();
        }
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          headers: { "Content-Security-Policy": pdfPolicy },
          body: html,
        });
      });
      const page = await context.newPage();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            await page.goto(pdfUrl, { waitUntil: "load", timeout: 15_000 });
            return page.pdf({
              outline: true,
              tagged: true,
              printBackground: true,
              preferCSSPageSize: true,
            });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new HttpError(504, "PDF export timed out.")),
              30_000,
            );
          }),
        ]);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, "Chromium could not render the PDF.");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await browser.close();
    }
  });
}

/** Only normalized workspace paths reach the DB; no path is handed to Pandoc. */
function imagePath(source: string, directory: string, root: string): string {
  const raw = source.split(/[?#]/, 1)[0];
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw.replace(/%20/g, " ");
  }
  if (path.startsWith("/")) {
    return workspacePath(posix.join(root, posix.normalize(path).slice(1)));
  }
  return workspacePath(posix.join(directory, path));
}

function inlines(text: string) {
  return text ? [{ t: "Str", c: text }] : [];
}

function htmlImage(tag: NonNullable<ReturnType<typeof parseImgTag>>) {
  const size = Object.entries({
    width: tag.size.width,
    height: tag.size.height,
  }).filter(([, value]) => value && /^\d+(\.\d+)?(px|%)$/.test(value));
  return {
    t: "Image",
    c: [["", [], size], inlines(tag.alt), [tag.src, tag.title ?? ""]],
  };
}

function isToc(block: unknown): boolean {
  if (
    !isObject(block) ||
    block.t !== "Para" ||
    !Array.isArray(block.c) ||
    block.c.length !== 1
  )
    return false;
  const [entry] = block.c;
  return (
    isObject(entry) &&
    entry.t === "Str" &&
    typeof entry.c === "string" &&
    /^\[toc\]$/i.test(entry.c)
  );
}

function imageNodes(value: unknown, targets: unknown[][]): void {
  if (Array.isArray(value)) {
    for (const entry of value) imageNodes(entry, targets);
  } else if (isObject(value)) {
    if (
      (value.t === "RawInline" || value.t === "RawBlock") &&
      Array.isArray(value.c) &&
      value.c[0] === "html" &&
      typeof value.c[1] === "string"
    ) {
      const tags = value.c[1].trim().split(/\r?\n/).map(parseImgTag);
      if (tags.every((tag) => tag !== null)) {
        const images = tags.map(htmlImage);
        Object.assign(
          value,
          value.t === "RawBlock" ? { t: "Para", c: images } : images[0],
        );
      }
    }
    if (
      value.t === "Image" &&
      Array.isArray(value.c) &&
      Array.isArray(value.c[2])
    ) {
      targets.push(value.c[2]);
    } else if ("c" in value) {
      imageNodes(value.c, targets);
    }
  }
}

async function embedPandocImages(
  blocks: unknown[],
  content: string,
  path: string | null,
  findAttachment: FindAttachment,
) {
  const directory = path ? posix.dirname(workspacePath(path)) : "";
  const rootSetting = findTyporaRootUrlInText(content) ?? "";
  const root = rootSetting.startsWith("/")
    ? posix.normalize(rootSetting).slice(1)
    : rootSetting
      ? posix.join(directory, rootSetting)
      : "";
  const targets: unknown[][] = [];
  imageNodes(blocks, targets);
  const cache = new Map<string, string>();
  let totalBytes = 0;
  for (const target of targets) {
    const source = target[0];
    if (typeof source !== "string") continue;
    // Pandoc's sandbox cannot load URLs or filesystem files. Keep existing
    // data URIs; resolve local Markdown image references only as DB keys.
    if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) continue;
    let key: string;
    try {
      key = imagePath(source, directory, root);
    } catch {
      throw new HttpError(
        422,
        "An image path is not a valid workspace attachment path.",
      );
    }
    if (!cache.has(key)) {
      const image = await findAttachment(key);
      if (!image || ![...imageTypes.values()].includes(image.mime)) {
        throw new HttpError(422, `Workspace image not found: ${key}`);
      }
      cache.set(
        key,
        `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`,
      );
    }
    const uri = cache.get(key);
    if (!uri) continue;
    totalBytes += uri.length;
    if (totalBytes > 24 * mib)
      throw new HttpError(413, "Export images exceed the size limit.");
    target[0] = uri;
  }
}

// A fixed filter, not supplied by the user. Images remain ordinary Markdown
// images even when Pandoc's archive readers attach figure captions and sizes.
const importFilter = `
function Image(img)
  img.attr = pandoc.Attr()
  return img
end
function Figure(fig)
  local images = {}
  fig:walk({ Image = function(img) table.insert(images, img) end })
  if #images == 0 then return nil end
  local caption = pandoc.utils.stringify(fig.caption.long)
  local inlines = {}
  for _, img in ipairs(images) do
    if #inlines > 0 then table.insert(inlines, pandoc.Space()) end
    img.attr = pandoc.Attr()
    if caption ~= "" then img.caption = pandoc.Inlines(caption) end
    table.insert(inlines, img)
  end
  return pandoc.Para(inlines)
end
`;

async function readMedia(
  directory: string,
  prefix: string,
): Promise<AssetInput[]> {
  const attachments: AssetInput[] = [];
  let totalBytes = 0;
  async function walk(folder: string) {
    for (const entry of await readdir(join(directory, folder), {
      withFileTypes: true,
    })) {
      const path = workspacePath(`${folder}/${entry.name}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const mime = imageTypes.get(extname(entry.name).toLowerCase());
      if (!entry.isFile() || !mime)
        throw new HttpError(
          415,
          "The imported file contains an unsupported attachment type.",
        );
      const { size } = await lstat(join(directory, path));
      totalBytes += size;
      if (
        attachments.length >= 100 ||
        size > 10 * mib ||
        totalBytes > 16 * mib
      ) {
        throw new HttpError(413, "Imported attachments exceed the size limit.");
      }
      const data = (await readFile(join(directory, path))).toString("base64");
      asset({ path, mime, data }); // Apply the same MIME checks as workspace uploads.
      attachments.push({ path, mime, data });
    }
  }
  const media = await lstat(join(directory, prefix)).catch((error) => {
    if (!isObject(error) || error.code !== "ENOENT") throw error;
    return null;
  });
  if (media) {
    if (!media.isDirectory())
      throw new HttpError(415, "Invalid extracted attachment folder.");
    await walk(prefix);
  }
  return attachments;
}

function outputUrl(stdout: Buffer): string {
  const output = stdout.toString("utf8").trim();
  try {
    if (/\s|[\p{Cc}\\]/u.test(output) || !/^https?:\/\//i.test(output))
      throw new Error();
    const url = new URL(output);
    if (url.username || url.password || !url.hostname) throw new Error();
    // The editor escapes this for Markdown or HTML at the replacement site.
    return output;
  } catch {
    throw new HttpError(
      502,
      "The uploader must print one HTTP or HTTPS URL for the uploaded file.",
    );
  }
}

export function createConversion(findAttachment: FindAttachment) {
  const pandoc = (args: string[], directory: string) =>
    run(
      "Pandoc",
      process.env.KALAMOS_PANDOC || "pandoc",
      ["--sandbox", "--data-dir=.", ...args],
      directory,
    );
  return {
    pdf: renderPdf,
    async export(
      format: string,
      content: string,
      path: string | null,
    ): Promise<Buffer> {
      const writer = exportFormats.get(format);
      if (!writer)
        throw new HttpError(415, "Unsupported Pandoc export format.");
      return inPrivateDirectory(async (directory) => {
        await writeFile(join(directory, "source.md"), content);
        const json = await pandoc(
          ["--from", markdownReader, "--to", "json", "source.md"],
          directory,
        );
        const doc = JSON.parse(json.toString("utf8"));
        if (!isObject(doc) || !Array.isArray(doc.blocks))
          throw new HttpError(502, "Pandoc did not return a document.");
        const blocks = doc.blocks.filter((block) => !isToc(block));
        const toc = blocks.length !== doc.blocks.length;
        doc.blocks = blocks;
        const textOnly = writer === "latex" || writer === "mediawiki";
        if (textOnly) {
          imageNodes(blocks, []); // Keep text output image paths relative to the document.
        } else {
          await embedPandocImages(blocks, content, path, findAttachment);
        }
        await writeFile(join(directory, "source.json"), JSON.stringify(doc));
        return pandoc(
          [
            "--from",
            "json",
            "--to",
            writer,
            ...(textOnly ? ["--standalone"] : []),
            ...(writer === "epub3" ? ["--mathml"] : []),
            ...(toc ? ["--toc"] : []),
            "source.json",
          ],
          directory,
        );
      });
    },
    async import(
      name: string,
      data: string,
    ): Promise<{ content: string; attachments: AssetInput[] }> {
      const reader = importFormats.get(extname(name).toLowerCase());
      if (!reader)
        throw new HttpError(415, "Unsupported Pandoc import format.");
      const input = base64(data, 20 * mib);
      return inPrivateDirectory(async (directory) => {
        const prefix = basename(directory).replace("convert", "media");
        await writeFile(join(directory, "source"), input);
        await writeFile(join(directory, "import.lua"), importFilter);
        const output = await pandoc(
          [
            "--from",
            reader,
            "--to",
            markdownWriter,
            "--wrap=none",
            "--lua-filter=import.lua",
            `--extract-media=${prefix}`,
            "source",
          ],
          directory,
        );
        if (output.length > 8 * mib)
          throw new HttpError(413, "Imported document exceeds 8 MiB.");
        return {
          content: output.toString("utf8").replaceAll("\u200b", ""),
          attachments: await readMedia(directory, prefix),
        };
      });
    },
    async upload(path: string): Promise<{ url: string }> {
      const command = process.env.KALAMOS_UPLOAD_COMMAND;
      if (!command)
        throw new HttpError(
          503,
          "Image upload is not configured on this server.",
        );
      const image = await findAttachment(workspacePath(path));
      if (!image) throw new HttpError(404, "Workspace attachment not found.");
      const extension = [...imageTypes].find(
        ([, mime]) => mime === image.mime,
      )?.[0];
      if (!extension)
        throw new HttpError(415, "Unsupported image type for upload.");
      return inPrivateDirectory(async (directory) => {
        const filename = join(directory, `image${extension}`);
        await writeFile(filename, image.data);
        const stdout = await run(
          "Image uploader",
          command,
          [filename],
          directory,
        );
        return { url: outputUrl(stdout) };
      });
    },
  };
}
