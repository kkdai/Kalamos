import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const widePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAAAAADaLSBnAAAAFUlEQVR4nGO4QyRgGFU4qnBUIQgAAFa3r58V64kUAAAAAElFTkSuQmCC",
  "base64",
);
export const refusedPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADwAAAAUCAAAAAD0aAH1AAAAGElEQVR4nGMIoAAwjGoe1TyqeVTzwGoGAMcXdxDILe0uAAAAAElFTkSuQmCC",
  "base64",
);
export const fixtureImageUrl =
  "https://image-uploader.fixture.invalid/stored.png";

/** Prepare a Compose override in a dedicated temporary directory. No network tools are used. */
export async function prepareUploadFixture(directory: string) {
  const command = "/kalamos-test-uploader";
  const log = "/kalamos-test-upload.log";
  const executableFile = resolve(directory, "upload");
  const logFile = resolve(directory, "upload.log");
  await writeFile(
    executableFile,
    `#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ -f "$1" ] || exit 3
case "$(base64 -w0 -- "$1")" in
  '${widePng.toString("base64")}')
    printf 'success\\n' >> '${log}'
    printf '%s\\n' '${fixtureImageUrl}'
    ;;
  '${refusedPng.toString("base64")}')
    printf 'failure\\n' >> '${log}'
    exit 1
    ;;
  *)
    printf 'unexpected input\\n' >> '${log}'
    exit 2
    ;;
esac
`,
    { mode: 0o755, flag: "wx" },
  );
  await writeFile(logFile, "", { flag: "wx" });
  // The container runs as the unprivileged node user. Only this disposable
  // file is writable; the executable is mounted read-only.
  await chmod(logFile, 0o666);
  await writeFile(
    join(directory, "compose.json"),
    JSON.stringify({
      services: {
        app: {
          environment: { KALAMOS_UPLOAD_COMMAND: command },
          volumes: [
            {
              type: "bind",
              source: executableFile,
              target: command,
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: "bind",
              source: logFile,
              target: log,
              bind: { create_host_path: false },
            },
          ],
        },
      },
    }),
    { flag: "wx" },
  );
}
