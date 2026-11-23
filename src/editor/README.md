# Shared editor host

`createEditor` uses the desktop host by default. Pass `host` to supply both live preview services for a different platform:

```ts
import { openBrowserExternalLink } from "./browser-editor-host";
import { createEditor } from "./index";

const editor = createEditor({
  parent,
  handlers,
  host: {
    resolveLocalImage: (path) =>
      attachmentPaths.has(path)
        ? `/api/assets?${new URLSearchParams({ path: path.slice(1) })}`
        : null,
    openExternalLink: openBrowserExternalLink,
  },
});
editor.setDocumentPath("/dir/doc.md");
```

- Give the editor the active document's absolute **workspace** path (not a host file path). Relative image sources resolve from the document folder. A source starting with `/` resolves from the workspace root unless `setImageRootDir` or `typora-root-url` front matter supplies another root. The front matter takes precedence and can be relative to the document folder.
- The resolver receives the resolved path. Return `null` for unknown attachments; the editor shows the missing path. If a mapped URL fails to load, the editor shows the failed path instead. Remote HTTP(S) and image data URLs do not call the resolver.
- After the attachment catalog changes, call `editor.refreshImages()` to resolve the current preview again, even if the document path and image URLs stay the same. This does not edit the document or reset the selection or undo history. Call `editor.setDocumentPath(newPath)` after a rename or tab switch to resolve from the new location.
- The external link handler receives HTTP(S) and `mailto:` links only. Heading links stay inside the editor; relative Markdown links use `onOpenRelativeLink`.
- A build that does not use Tauri must alias the exact import `./desktop-editor-host` to `src/editor/browser-editor-host.ts`. The browser adapter opens external links and resolves no local files by default. It does not load desktop IPC or emulate desktop permissions.
