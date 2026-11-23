# Local Web API

The API serves the built app from `web/dist` and keeps workspace data in PostgreSQL. Run `npm run build:web` and `npm run start:web` from the repository root. For development, run `npm run start:web` and `npm run dev:web` in separate terminals. Use Node.js 22.18 or newer.

| Environment variable | Default / purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql://kalamos:kalamos_dev@127.0.0.1:5432/kalamos`. Use a dedicated workspace database. The API applies pending SQL migrations at startup, before listening. |
| `KALAMOS_WEB_HOST` | `127.0.0.1`. In a container, bind to `0.0.0.0` and publish the port on the host's loopback address only. |
| `KALAMOS_WEB_PORT` | `4173`. |
| `KALAMOS_WEB_ALLOWED_HOSTS` | Adds comma-separated exact `host[:port]` values. The defaults allow `localhost`, `127.0.0.1` and `[::1]`, each bare or with the API or Vite development port (`5173`). |
| `KALAMOS_CHROMIUM` | Path to a sandbox-capable Chromium executable for PDF export. If unset, Playwright uses its installed Chromium. Compose provides Chromium. |
| `KALAMOS_PANDOC` | Path to an official Pandoc executable with built-in templates and `--sandbox`. Defaults to `pandoc` on PATH. Compose provides 3.8.3. |
| `KALAMOS_UPLOAD_COMMAND` | No default. An operator-configured executable on the API host, called without a shell with an image's temporary path as its sole argument. It must print one HTTP(S) URL. Browser users must explicitly confirm the upload; the request never supplies the executable. |
| `TEST_DATABASE_URL` | Required by `npm run test:web:api`. Use a dedicated test database; the test creates and drops a random schema. |

The service has no user authentication. Do not expose it off the local machine. A proxy must preserve `Host`. When a request supplies `Origin`, it must match the HTTP origin for that `Host`. POST and PATCH requests require `Content-Type: application/json` and a UTF-8 JSON object.

| Method and path | Request / result |
| --- | --- |
| `GET /api/health` | Returns `{ "ok": true }` when the API can query PostgreSQL. |
| `GET /api/documents?trash=1&q=…` | Array of `{id,path,revision,deleted,updatedAt}`. Omit `trash=1` for active documents. `q` is a case-insensitive literal substring of the path or body. |
| `GET /api/search?q=…&case=1&word=1&regex=1` | `{hits,truncated}`. Searches saved document contents line by line, excluding trash. The three options are independent and are off by default. See details below. |
| `POST /api/documents` | `{path,content,attachments?:[{path,mime,data}]}`. Returns the created document, including `content`. Creation and attachment writes commit together or not at all. |
| `GET /api/documents/:id` | Returns a document including its `content`, even in trash. |
| `PATCH /api/documents/:id` | `{revision,content?,path?,deleted?}`. Supply at least one change. Returns the updated document with its new revision. A stale revision or a path used by another active document returns 409. Trash releases the active path; restoration needs a free path. |
| `GET /api/settings` | Returns the saved settings object or `{}`. |
| `POST /api/settings` | Replaces the entire settings object and returns it. |
| `GET /api/assets?path=…` | Returns an image. URL-encode the workspace path as a query value. |
| `POST /api/assets` | `{path,mime,data}` → `{path}`. The same MIME and bytes can reuse a path; different data returns 409. |
| `POST /api/convert/pdf` | `{html}` → PDF download. |
| `POST /api/convert/export` | `{format,content,path}` → binary download. A null or omitted path means no current document path. |
| `POST /api/convert/import` | `{name,data}` → `{content,attachments}`. Convert first, then use `POST /api/documents` to save the result. |
| `POST /api/convert/upload` | `{path}` → `{url}` when the operator configured an uploader. |

Workspace content search accepts at most 1,024 UTF-8 bytes of query text. Search is literal and case-insensitive by default. Whole-word mode excludes matches continued by adjacent alphanumeric characters or underscores. Regex mode uses PostgreSQL advanced regular expressions, not the desktop Rust regex dialect. It ignores zero-length matches; for example, `^` alone gives no hits. Invalid patterns return 422. The search statement has a one-second deadline (408 on timeout).

The API returns up to 1,000 hits. `truncated` is true only if more hits matched. Each hit contains `{id,path,revision,line,column,length,before,match,after}`. Line and column start at 1; columns and lengths count UTF-16 code units so the editor can select the match. `before`, `match`, and `after` are bounded snippets, not full lines. Use the returned revision to check that the editor still shows the searched version.

Errors return `{error}` with an HTTP status. If the connection drops while PostgreSQL commits a save, the server may not know whether it committed. Check the current revision before retrying. Workspace paths are not file system paths. Use relative, slash-separated names with no empty, `.` or `..` segments. Paths are case-sensitive. Attachment and conversion input `data` is padded base64, not a data URL. The server checks image signatures and supports PNG, JPEG, GIF, WebP, AVIF, BMP and ICO. It rejects SVG. Request JSON is limited to 32 MiB, Markdown to 8 MiB, each image to 10 MiB, and settings to 256 KiB.
