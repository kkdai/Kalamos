import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createConversion } from "./conversion.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=";
const image = { mime: "image/png", data: Buffer.from(png, "base64") };

function setEnv(t: TestContext, key: string, value?: string) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

test("conversions validate formats and do not run an unconfigured uploader", async (t) => {
  setEnv(t, "KALAMOS_UPLOAD_COMMAND");
  setEnv(t, "KALAMOS_PANDOC", join(tmpdir(), "nonexistent-kalamos-pandoc"));
  const conversion = createConversion(async () =>
    assert.fail("unexpected attachment access"),
  );
  await assert.rejects(conversion.upload("image.png"), {
    status: 503,
    message: /not configured/,
  });
  await assert.rejects(conversion.export("template.lua", "hello", null), {
    status: 415,
  });
  await assert.rejects(conversion.import("file.txt", "YQ=="), { status: 415 });
  await assert.rejects(conversion.import("file.docx", "not-base64"), {
    status: 400,
  });
  await assert.rejects(conversion.export("docx", "hi", null), {
    status: 503,
    message: /Pandoc is unavailable/,
  });
});

test("upload maps one stored attachment and cleans the private file on success and failure", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "kalamos-uploader-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  // An executable with spaces in its name still works: invocation does not involve a shell.
  const command = join(fixture, "upload test");
  const log = join(fixture, "log");
  setEnv(t, "KALAMOS_UPLOAD_COMMAND", command);
  setEnv(t, "KALAMOS_TEST_PRIVATE_ENV", "do not send this to tools");
  const keys: string[] = [];
  const conversion = createConversion(async (path) => {
    keys.push(path);
    return image;
  });
  async function configure(body: string) {
    await writeFile(
      command,
      `#!/bin/sh\nset -eu\n[ "$#" = 1 ]\n[ -z "\${KALAMOS_TEST_PRIVATE_ENV:-}" ]\n[ "$(base64 < "$1" | tr -d '\\r\\n')" = "${png}" ]\nprintf '%s' "$PWD" > '${log}'\n${body}\n`,
      { mode: 0o700 },
    );
  }
  await configure("printf 'https://example.test/picture(1).png\\n'");
  assert.deepEqual(await conversion.upload("folder/pic.png"), {
    url: "https://example.test/picture(1).png",
  });
  assert.deepEqual(keys, ["folder/pic.png"]);
  await assert.rejects(stat(await readFile(log, "utf8")), { code: "ENOENT" });
  await configure("printf 'file:///tmp/no.png\\n'");
  await assert.rejects(conversion.upload("folder/pic.png"), {
    status: 502,
    message: /HTTP or HTTPS/,
  });
  await assert.rejects(stat(await readFile(log, "utf8")), { code: "ENOENT" });
  await configure("printf 'https://example.test/pic.png\\n'; exit 1");
  await assert.rejects(conversion.upload("folder/pic.png"), {
    status: 502,
    message: /failed/,
  });
  await assert.rejects(stat(await readFile(log, "utf8")), { code: "ENOENT" });
  await assert.rejects(conversion.upload("../image.png"), { status: 400 });
});

const markdown = `# Parent\n\n[TOC]\n\n## 子標題\n\n- first item\n- second item\n\n| Head | Value |\n| --- | --- |\n| item | 123 |\n\n$x+1$\n\nReference: ![pixel][png]\n\n[png]: assets/a%20b.png\n`;

test("real Pandoc converts all writers and round-trips archive attachments", {
  skip: !process.env.KALAMOS_TEST_PANDOC,
  timeout: 30_000,
}, async (t) => {
  setEnv(t, "KALAMOS_PANDOC", process.env.KALAMOS_TEST_PANDOC);
  const temp = await mkdtemp(join(tmpdir(), "kalamos-pandoc-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  setEnv(t, process.platform === "win32" ? "TEMP" : "TMPDIR", temp);
  const keys: string[] = [];
  const conversion = createConversion(async (path) => {
    keys.push(path);
    return path === "folder/assets/a b.png" ? image : null;
  });
  for (const format of ["docx", "odt", "epub"]) {
    const blob = await conversion.export(format, markdown, "folder/source.md");
    assert.equal(blob.subarray(0, 2).toString(), "PK");
    const imported = await conversion.import(
      `sample.${format}`,
      blob.toString("base64"),
    );
    assert.match(imported.content, /# .*Parent/);
    assert.match(imported.content, /## .*子標題/);
    assert.match(imported.content, /first item/);
    assert.match(imported.content, /\|\s*Head\s*\|\s*Value\s*\|/);
    assert.match(imported.content, /\|\s*item\s*\|\s*123\s*\|/);
    // Pandoc exports ODT math objects but its ODT reader drops them.
    if (format !== "odt") assert.match(imported.content, /\$x\s*\+\s*1\$/);
    assert.equal(imported.attachments.length, 1);
    assert.equal(imported.attachments[0].mime, image.mime);
    assert.equal(imported.attachments[0].data, png);
    assert.ok(imported.content.includes(`(${imported.attachments[0].path})`));
  }
  assert.deepEqual(keys, Array(3).fill("folder/assets/a b.png"));
  assert.match(
    (await conversion.export("latex", markdown, "folder/source.md")).toString(),
    /\\begin\{document\}/,
  );
  assert.match(
    (
      await conversion.export("mediawiki", markdown, "folder/source.md")
    ).toString(),
    /=+\s*Parent\s*=+/,
  );
  await assert.rejects(
    conversion.export("docx", "![missing](missing.png)", "folder/source.md"),
    { status: 422 },
  );
  await assert.rejects(conversion.import("broken.docx", "YQ=="), {
    status: 422,
  });
  const textFormats = [
    [
      "sample.tex",
      String.raw`\section{Test}\begin{itemize}\item One\end{itemize}$1$`,
    ],
    [
      "sample.html",
      "<h1>Test</h1><ul><li>One</li></ul><math><mn>1</mn></math>",
    ],
    ["sample.wiki", "== Test ==\n\n* One\n\n<math>1</math>"],
  ];
  for (const [name, source] of textFormats) {
    const imported = await conversion.import(
      name,
      Buffer.from(source).toString("base64"),
    );
    assert.match(imported.content, /#+ Test/);
    assert.match(imported.content, /- One/);
    assert.match(imported.content, /\$1\$/);
    assert.deepEqual(imported.attachments, []);
  }
  assert.deepEqual(await readdir(temp), []);
});

test("real Chromium prints named, nested PDF bookmarks and data images without network", {
  skip: !process.env.KALAMOS_TEST_CHROMIUM,
  timeout: 30_000,
}, async (t) => {
  setEnv(t, "KALAMOS_CHROMIUM", process.env.KALAMOS_TEST_CHROMIUM);
  let requests = 0;
  const probe = createServer((_request, response) => {
    requests++;
    response.end();
  });
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  t.after(() => probe.close());
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const remote = `http://127.0.0.1:${address.port}/external`;
  const conversion = createConversion(async () =>
    assert.fail("PDF service must not access attachments"),
  );
  const pdf = await conversion.pdf(`<!DOCTYPE html><title>Outline test</title>
    <link rel="stylesheet" href="${remote}">
    <a href="#parent">Parent link</a>
    <h1 id="parent">Parent</h1><h2 id="child">Child</h2><h3>Leaf</h3><h1>Sibling</h1>
    <img alt="remote" src="${remote}"><img alt="local" src="data:image/png;base64,${png}">`);
  const text = pdf.toString("latin1");
  assert.match(text, /^%PDF-/);
  assert.match(text, /\/Outlines \d+ 0 R/);
  assert.match(text, /\/Dest \/parent/);
  assert.match(text, /\/Subtype \/Image/);
  const parent = text.match(/(\d+) 0 obj\n<<\/Title \(Parent\)[\s\S]*?endobj/);
  assert.ok(parent);
  assert.match(
    text,
    new RegExp(`<<\\/Title \\(Child\\)[^>]+\\/Parent ${parent[1]} 0 R`),
  );
  assert.match(text, /\/Title \(Leaf\)/);
  assert.match(text, /\/Title \(Sibling\)/);
  assert.equal(requests, 0);
});
