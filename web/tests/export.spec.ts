import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
  databaseDocument,
  documentFrom,
  expect,
  fileOperation,
  openDocument,
  png,
  seedDocument,
  start,
  test,
  waitForApi,
} from "./fixtures";

const exec = promisify(execFile);
const verifier = fileURLToPath(new URL("./verify-export.py", import.meta.url));

async function verify(...args: string[]) {
  await exec("uv", ["run", "--offline", "--script", verifier, ...args], {
    timeout: 15_000,
  });
}

const sections = [
  "# Parent Chapter",
  "",
  "寫作 sample",
  "",
  "## Child Chapter",
  "",
  "- A list item",
  "- Another item",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| TableValue | 42 |",
  "",
  '<img src="assets/example.png" alt="Included image" width="32" />',
  "",
].join("\n");
const equation = "\n$$\nx^2+1\n$$\n";
const diagram =
  "\n```mermaid\nflowchart TD\n  A[DiagramAnchor] --> B[Done]\n```\n";

async function exportTo(
  page: Page,
  format: "docx" | "pdf",
  docName: string,
  output: string,
) {
  await fileOperation(page, "convert-document");
  const dialog = page.locator("#export-dialog");
  await dialog.locator("#export-format").selectOption(format);
  const download = page.waitForEvent("download");
  const converting = waitForApi(
    page,
    "POST",
    format === "pdf" ? "convert/pdf" : "convert/export",
  );
  await dialog.getByRole("button", { name: "匯出", exact: true }).click();
  const response = await converting;
  expect(response.ok(), response.ok() ? undefined : await response.text()).toBe(
    true,
  );
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`${docName}.${format}`);
  await saved.saveAs(output);
  expect(await readFile(output)).toEqual(await response.body());
}

test("WEB-06: round-trip real Pandoc DOCX with headings, list, table, math, and attachment", async ({
  page,
  request,
  name,
}, testInfo) => {
  const source = `${name}/article.md`;
  await seedDocument(request, source, `${sections}${equation}`, [
    {
      path: `${name}/assets/example.png`,
      mime: "image/png",
      data: png.toString("base64"),
    },
  ]);
  await start(page);
  await openDocument(page, source);
  const output = testInfo.outputPath(`${name}.docx`);
  await exportTo(page, "docx", "article", output);
  await verify("docx", output);

  const chooser = page.waitForEvent("filechooser");
  const converting = waitForApi(page, "POST", "convert/import");
  const creating = waitForApi(page, "POST", "documents");
  await fileOperation(page, "import-converted");
  await (await chooser).setFiles(output);
  const result = await converting;
  expect(result.ok(), await result.text()).toBe(true);
  const doc = await documentFrom(await creating);
  expect(doc.path).toBe(`${name}.md`);
  expect(doc.content).toMatch(/^# Parent Chapter$/m);
  expect(doc.content).toMatch(/^## Child Chapter$/m);
  expect(doc.content).toMatch(/^-\s+A list item$/m);
  expect(doc.content).toMatch(/\|\s*TableValue\s*\|\s*42\s*\|/);
  expect(doc.content).toMatch(/\${1,2}\s*x\^\{?2\}?\s*\+\s*1\s*\${1,2}/);
  const attachments = (await result.json()).attachments;
  expect(attachments).toHaveLength(1);
  const image = await request.get("/api/assets", {
    params: { path: attachments[0].path },
  });
  await expect(image).toBeOK();
  expect(await image.body()).toEqual(png);
  expect((await databaseDocument(request, doc.id)).content).toBe(doc.content);
  await expect(page.locator("#open-documents [aria-current=true]")).toHaveText(
    `${name}.md`,
  );
  await expect(
    page.getByRole("img", { name: "Included image" }),
  ).toHaveJSProperty("naturalWidth", 1);
});

test("WEB-06: real PDF includes nested bookmarks, table, local image, vector equation, and diagram", async ({
  page,
  request,
  name,
}, testInfo) => {
  const path = `${name}/article.md`;
  const control = `${name}/control.md`;
  await seedDocument(request, path, `${sections}${equation}${diagram}`, [
    {
      path: `${name}/assets/example.png`,
      mime: "image/png",
      data: png.toString("base64"),
    },
  ]);
  await seedDocument(request, control, `${sections}${diagram}`);
  await start(page);
  const sample = testInfo.outputPath("article.pdf");
  const baseline = testInfo.outputPath("control.pdf");
  await openDocument(page, path);
  await exportTo(page, "pdf", "article", sample);
  await openDocument(page, control);
  await exportTo(page, "pdf", "control", baseline);
  await verify("pdf", sample, baseline);
});
