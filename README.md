<p align="center">
  <img src="site/assets/kalamos-icon.svg" alt="Kalamos icon" width="96" height="96" />
</p>

<h1 align="center">Kalamos</h1>

<p align="center">
  <strong>Write, and it appears.</strong><br />
  A Typora-style WYSIWYM live-preview Markdown desktop editor for macOS, built with Tauri 2 and CodeMirror 6.<br />
  Free, offline, no account, no telemetry.
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="site/assets/screenshots/hero-live-preview.png" alt="Kalamos live preview in the Papyros light theme" width="820" />
</p>

> **Kalamos** (*κάλαμος*, pronounced *KA-la-mos*) is the Ancient Greek word for the reed pen used to write on papyrus. The interface stays out of your way until you need a tool, keeping your documents in standard, portable GitHub Flavored Markdown (GFM).

---

## Features

### Live Preview Editing (WYSIWYM)
- **Single-pane live preview** (`ED-01`): Headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, links, blockquotes, horizontal rules, and lists render immediately as soon as the closing mark is typed; syntax markers hide when the cursor moves away and fade back in when you return.
- **Source Mode** (`ED-02`): Switch to raw Markdown anytime with `Cmd+/` while preserving your cursor position.
- **CJK & IME friendly**: CJK emphasis flanking works naturally next to full-width punctuation, and decorations freeze during IME composition to prevent layout jumps. Preserves original CRLF/LF line endings and UTF-8 BOM on unmodified saves.
- **Lists & Task Lists** (`ED-04`): Bullet, ordered, and interactive GFM task lists (`- [ ]` / `- [x]`) with clickable checkboxes, `Tab` / `Shift+Tab` indent and outdent, smart `Enter` / `Backspace` continuation and exit, and keyboard toggles.
- **Links & Heading Bookmarks** (`ED-05`): External URLs (`http://`, `https://`, `mailto:`), relative `.md` links, internal `#heading` anchor jumps, and `Cmd+Shift+C` to copy a heading bookmark link.
- **Rich Blocks & Live `[TOC]`** (`ED-06`, `ED-07`): Blockquotes, horizontal rules, YAML Front Matter, footnotes with hover tooltips and click-to-jump navigation, and `[TOC]` auto-updating table of contents.
- **Emoji Autocomplete** (`ED-08`): Offline GitHub `gemoji` shortcode completion when typing `:name`, loaded lazily on first use.
- **Auto-Pairing** (`ED-09`): Automatic pairing of ASCII and CJK full-width brackets and quotes (`() [] {} "" ''` and `「」『』（）【】《》“”‘’`, enabled by default, `Cmd+Opt+P`), plus optional Markdown symbol pairing `* _ ` ~` (`Cmd+Opt+Shift+P`).

### Tables
- **Visual GFM Tables** (`BL-01`): Edit cells directly in place with `Tab`, `Shift+Tab`, and `Enter`; press `Cmd+Enter` to leave the table.
- **Fast Creation**: Press `Cmd+Opt+T` to open the Insert Table dialog (with grid picker and row/column inputs), or type `|a|b|` and press `Enter` to turn a pipe row into a table.
- **Floating Toolbar & Context Menu**: A non-overlapping toolbar floats above the active table (with scroll compensation so the current cell never jumps), plus a matching right-click menu.
- **Structure & Alignment**: Add/delete rows and columns, drag borders to resize columns, toggle left/center/right alignment, move columns left/right, delete tables, and revert any operation in a single Undo step. Automatically pads Markdown columns with double-width CJK support. See [docs/tables.md](docs/tables.md).

<p align="center">
  <img src="site/assets/screenshots/table-editor.png" alt="Kalamos visual table editor with floating toolbar" width="760" />
</p>

### Math, Diagrams & Code Blocks
- **Code Blocks** (`BL-02`): Syntax highlighting for 100+ languages via `@codemirror/language-data` with low-saturation theme-matched colors and toggleable line numbers (`Cmd+Opt+L`).
- **Math Formulas** (`BL-03`): Offline MathJax 3 SVG rendering for inline `$...$` and display `$$...$$` equations with `ams`, `mhchem` (chemistry), `bbox`, and `newcommand` packages; lazy viewport-only rendering; live preview below the active block; optional AMS auto-numbering (`Cmd+Opt+N`).
- **Diagrams** (`BL-04`): Offline SVG rendering for `mermaid`, `flow` (flowchart.js syntax), and `sequence` (js-sequence-diagrams syntax) styled to match the active theme, with debounced live preview and line-numbered syntax error messages.

<p align="center">
  <img src="site/assets/screenshots/math-diagrams.png" alt="Kalamos rendering MathJax formulas and Mermaid diagrams" width="760" />
</p>

### Images & Custom Upload
- **Inline Image Preview** (`IM-01`): Displays both local and remote images inline.
- **Drag-and-Drop & Clipboard Paste** (`IM-02`): Dropping or pasting images saves them into an `assets/` folder beside the document and inserts clean relative links.
- **Image Sizing** (`IM-03`): Supports HTML `<img>` tags with `width`, `height`, and `style="zoom: ...%"`.
- **Image Root Folder** (`IM-04`): Resolve `/`-rooted paths for static site generators using `Cmd+Opt+R` (`Cmd+Opt+Shift+R` to clear) or YAML Front Matter `typora-root-url`.
- **Custom CLI Uploader** (`IM-05`): Press `Cmd+Opt+U` (or enable `uploadOnInsert`) to upload local images through any CLI tool such as PicGo CLI, configured exclusively via `settings.json` for security. See [docs/image-upload.md](docs/image-upload.md).

### Export & Import
- **Native PDF Export** (`EX-01`, `Cmd+Shift+E`): Paginates to A4 via a hidden JavaScript-disabled `WKWebView` + `NSPrintOperation` and embeds a nested PDF outline bookmark tree (`PDFKit`) matching heading hierarchy, including rendered math and diagrams.
- **Pandoc Export** (`EX-02`, `Cmd+Opt+E`): Export to **DOCX**, **ODT** (OpenOffice / LibreOffice), **LaTeX**, **MediaWiki**, and **EPUB** (requires optional Pandoc). Resolves `[TOC]`, local image paths, and `<img>` sizes automatically.
- **Pandoc Import** (`EX-03`, `Cmd+Opt+I`): Import **DOCX**, **ODT**, **EPUB**, **LaTeX**, **HTML**, and **MediaWiki** into clean GFM Markdown with `$...$` / `$$...$$` math and extracted media (requires Pandoc 2.15+ for `--sandbox`).

### Writing Modes
- **Ataraxia Focus Mode** (`WM-01`, `F8`): Softly dims every block outside the active paragraph, list item, or selection.
- **Stichos Typewriter Mode** (`WM-02`, `F9`): Keeps the active cursor line vertically centered while typing.

### Themes
- **Built-in Themes** (`TH-01`): **Papyros** (warm papyrus light), **Melan** (ink dark), and **System** auto-switching (`prefers-color-scheme`), paired with bundled open-source typography (`Source Serif 4`, `Noto Serif TC`, `Inter`, `Noto Sans TC`, `JetBrains Mono`).
- **Custom CSS Themes**: Place `.css` files in `~/Library/Application Support/io.kalamos.app/themes/` to customize `--k-*` variables, typography, paragraph alignment, or automatic heading counters. Switch via the theme menu or `Cmd+Shift+T`. See [docs/themes.md](docs/themes.md).

<p align="center">
  <img src="site/assets/screenshots/dark-theme-melan.png" alt="Kalamos Melan dark theme" width="760" />
</p>

### Files, Sidebar & Reliability
- **Sidebar** (`NV-01`, `NV-02`): Toggle with `Cmd+Shift+L` and open folders with `Cmd+Shift+O`. Switch between **File Tree**, **File List** (with excerpts), and **Outline** (heading navigation). Create, rename, and move files to Trash; watches external filesystem changes (compatible with iCloud Drive and Dropbox folders).
- **Word Count** (`NV-03`): Live status-bar count of reader-visible words (CJK + Latin), grapheme characters, lines, and estimated reading time, with automatic selection stats when text is highlighted.
- **Safe Saving & Crash Recovery**: Atomic temp-file + rename writes, 1-second debounced autosave for saved files, and 5-second crash-recovery snapshots for untitled drafts with a one-click restore banner on relaunch.

---

## Keyboard Shortcuts

| Category | Action | Shortcut |
| --- | --- | --- |
| **File** | New document | `Cmd+N` |
| | Open file | `Cmd+O` |
| | Save / Save As | `Cmd+S` / `Cmd+Shift+S` |
| | Open folder in sidebar | `Cmd+Shift+O` |
| **View & Modes** | Toggle Source Mode | `Cmd+/` |
| | Toggle Sidebar | `Cmd+Shift+L` |
| | Cycle Theme | `Cmd+Shift+T` |
| | Ataraxia Focus Mode | `F8` |
| | Stichos Typewriter Mode | `F9` |
| **Formatting** | Bold / Italic | `Cmd+B` / `Cmd+I` |
| | Inline code | `Cmd+Shift+`` ` `` |
| | Insert / toggle link | `Cmd+K` |
| | Ordered / Bullet / Task list | `Cmd+Shift+[` / `Cmd+Shift+]` / `Cmd+Shift+X` |
| | Indent / Outdent list item | `Tab` / `Shift+Tab` |
| | Copy heading bookmark link | `Cmd+Shift+C` |
| **Blocks & Code** | Toggle code line numbers | `Cmd+Opt+L` |
| | Toggle math auto-numbering | `Cmd+Opt+N` |
| | Toggle bracket / Markdown auto-pairing | `Cmd+Opt+P` / `Cmd+Opt+Shift+P` |
| **Tables** | Insert table dialog | `Cmd+Opt+T` |
| | Next / previous cell | `Tab` / `Shift+Tab` |
| | Leave table | `Cmd+Enter` |
| | Insert row above / below | `Cmd+Opt+↑` / `Cmd+Opt+↓` |
| | Insert column left / right | `Cmd+Opt+←` / `Cmd+Opt+→` |
| | Delete row / column | `Cmd+Shift+Backspace` / `Cmd+Opt+Backspace` |
| | Align column left / center / right | `Cmd+Opt+Shift+←` / `↑` / `→` |
| **Images** | Set / clear image root folder | `Cmd+Opt+R` / `Cmd+Opt+Shift+R` |
| | Upload local images | `Cmd+Opt+U` |
| **Export & Import** | Export PDF (with bookmarks) | `Cmd+Shift+E` |
| | Export via Pandoc (DOCX/ODT/LaTeX/Wiki/EPUB) | `Cmd+Opt+E` |
| | Import via Pandoc | `Cmd+Opt+I` |

---

## Installation (macOS)

1. Download the latest `.dmg` from [GitHub Releases](https://github.com/kkdai/Kalamos/releases).
2. Open the `.dmg` and drag **Kalamos.app** into `/Applications`.
3. **Opening an unsigned build**: Release builds are currently not Apple-notarized. On first launch, macOS Gatekeeper may block the app. To open it:
   - **Option A (Finder)**: Right-click (or Control-click) **Kalamos.app** → **Open** → confirm **Open** (or go to **System Settings → Privacy & Security** and click **Open Anyway**).
   - **Option B (Terminal)**: Clear the quarantine attribute:
     ```bash
     xattr -cr /Applications/Kalamos.app
     ```
4. **Make Kalamos the default for Markdown**: in Finder, select any `.md` file → **Get Info** (⌘I) → **Open with: Kalamos** → **Change All…**. Double-clicking a `.md` file, dropping one on the Dock icon, or `open -a Kalamos file.md` then opens it in Kalamos.

---

## Building from Source

### Prerequisites
- **macOS** with Xcode Command Line Tools (`xcode-select --install`)
- **Node.js** 22+ and npm
- **Rust** stable toolchain (`rustup`)
- **Pandoc** *(optional)* — only needed for DOCX / ODT / LaTeX / MediaWiki / EPUB export and import (2.15+ required for import):
  ```bash
  brew install pandoc
  ```

### Build Commands
```bash
npm ci
npm run tauri build
```

The built `.app` and `.dmg` bundles will be generated under `src-tauri/target/release/bundle/`.

---

## Development & Testing

```bash
# Run the frontend Vite dev server (port 1420, uses in-memory IPC mock in browser)
npm run dev

# Run the full Tauri desktop app in development mode
npm run tauri dev

# Type-check and build frontend assets
npm run build

# Frontend unit tests (Vitest)
npm test

# End-to-end tests (Playwright, headless Chromium against IPC mock)
npm run test:e2e

# Rust backend tests & linter
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 10,000-line document performance benchmark
npm run bench
```

---

## Known Limitations

- **macOS only**: Native PDF export relies on macOS `WKWebView`, `NSPrintOperation`, and `PDFKit`; Windows and Linux packaging are not supported yet.
- **No GUI Preferences window yet**: Most toggles work via shortcuts and persist automatically in `~/Library/Application Support/io.kalamos.app/settings.json`; image uploader settings (`uploadCommand`, `uploadArgs`, `uploadOnInsert`) are edited directly in that file.
- **Pandoc is external**: Multi-format export (`EX-02`) and import (`EX-03`) require installing Pandoc separately (2.15+ for sandboxed import).
- **Unsigned macOS builds**: Prebuilt `.dmg` releases require manual Gatekeeper approval on first launch.
- **iPic preset**: macOS iPic is not built in as a preset; any CLI image uploader matching the stdout URL contract can be configured as `uploadCommand`.
- **Out of scope by design**: No accounts, cloud sync service (use local iCloud/Dropbox folders), real-time collaboration, plugin marketplace, or built-in AI assistant.

---

## Documentation

- Product Requirements: [docs/PRD.md](docs/PRD.md)
- Visual Tables Guide: [docs/tables.md](docs/tables.md)
- Custom CSS Themes Guide: [docs/themes.md](docs/themes.md)
- Custom Image Upload Guide: [docs/image-upload.md](docs/image-upload.md)

---

## License

Released under the [MIT License](LICENSE).
