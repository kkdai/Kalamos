#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Formats GitHub draft release notes using the project template and SHA256SUMS.
 */
export function formatReleaseNotes({ version, checksumsText }) {
  const trimmedChecksums = checksumsText.trim();
  const files = trimmedChecksums
    ? trimmedChecksums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
        .filter(Boolean)
    : [];

  const armDmg =
    files.find((f) => /aarch64\.dmg$/i.test(f)) ||
    `Kalamos_${version}_aarch64.dmg`;
  const x64Dmg =
    files.find((f) => /x64\.dmg$/i.test(f)) || `Kalamos_${version}_x64.dmg`;
  const nsisExe =
    files.find((f) => /-setup\.exe$/i.test(f)) ||
    `Kalamos_${version}_x64-setup.exe`;
  const msi =
    files.find((f) => /\.msi$/i.test(f)) ||
    `Kalamos_${version}_x64_en-US.msi`;

  return [
    `## Kalamos v${version}`,
    "",
    "<!-- 發布前請在此補充本版本的新功能、改進與修正摘要 -->",
    "",
    "### 安裝方式",
    "",
    "#### macOS",
    `- **Apple Silicon（M1 / M2 / M3 / M4）**：下載 \`${armDmg}\``,
    `- **Intel Mac**：下載 \`${x64Dmg}\``,
    "",
    "開啟 `.dmg` 後，將 **Kalamos.app** 拖進「應用程式（Applications）」資料夾。",
    "",
    "> **未經 Apple 公證提示**：本版本使用 ad-hoc 簽章，尚未經過 Apple 公證（Notarization）。首次開啟時若系統阻擋，請在 Finder 對 **Kalamos.app** 按右鍵並選擇「打開」，或前往「系統設定 → 隱私權與安全性」允許開啟。",
    "",
    "#### Windows（10 / 11 x64）",
    `- **NSIS 安裝程式（建議，不需系統管理員權限）**：下載 \`${nsisExe}\``,
    `- **MSI 安裝程式**：下載 \`${msi}\``,
    "",
    "若系統尚未安裝 Microsoft Edge WebView2 Runtime，安裝程式會自動下載並安裝。",
    "",
    "> **未經程式碼簽章提示**：本版本尚未經過 Windows 程式碼簽章。執行安裝程式時若出現 Windows Defender SmartScreen 警告，請點選「其他資訊」→「仍要執行」。",
    "",
    "### 檔案校驗（SHA-256）",
    "",
    "完整校驗清單亦附於 `SHA256SUMS.txt`：",
    "",
    "```text",
    trimmedChecksums,
    "```",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = { version: "", checksumsPath: "", outputPath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") {
      opts.version = argv[++i] ?? "";
    } else if (arg === "--checksums") {
      opts.checksumsPath = argv[++i] ?? "";
    } else if (arg === "--output") {
      opts.outputPath = argv[++i] ?? "";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.version) throw new Error("--version is required");
  if (!opts.checksumsPath) throw new Error("--checksums is required");
  return opts;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const checksumsText = readFileSync(resolve(opts.checksumsPath), "utf8");
    const notes = formatReleaseNotes({
      version: opts.version,
      checksumsText,
    });
    if (opts.outputPath) {
      writeFileSync(resolve(opts.outputPath), notes, "utf8");
    } else {
      process.stdout.write(notes);
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
