import { openUrl } from "@tauri-apps/plugin-opener";
import {
  allowAssetDir,
  allowAssetFile,
  isAssetDirTooBroadError,
  isTauri,
  localFileUrl,
} from "../ipc";
import { openBrowserExternalLink } from "./browser-editor-host";
import type { DefaultEditorHost, ImageAssetAccess } from "./editor-host";

const allowedAssetFiles = new Set<string>();
const pendingAssetFiles = new Map<string, Promise<boolean>>();
const allowedRoots = new Set<string>();

const assetAccess: ImageAssetAccess = {
  isFileAllowed: (path) => allowedAssetFiles.has(path),
  ensureFileAllowed(path) {
    if (allowedAssetFiles.has(path)) return Promise.resolve(true);
    const pending = pendingAssetFiles.get(path);
    if (pending) return pending;
    const request = allowAssetFile(path).then(
      () => {
        allowedAssetFiles.add(path);
        return true;
      },
      () => false,
    );
    pendingAssetFiles.set(path, request);
    void request.finally(() => pendingAssetFiles.delete(path));
    return request;
  },
  resetFileCache() {
    allowedAssetFiles.clear();
    pendingAssetFiles.clear();
  },
  allowRoot(root, onRefused) {
    if (allowedRoots.has(root)) return;
    allowedRoots.add(root);
    void allowAssetDir(root).catch((err: unknown) => {
      allowedRoots.delete(root);
      if (isAssetDirTooBroadError(err)) onRefused();
    });
  },
};

export const defaultEditorHost: DefaultEditorHost = {
  resolveLocalImage: localFileUrl,
  openExternalLink(url) {
    if (isTauri()) return openUrl(url);
    openBrowserExternalLink(url);
  },
  assetAccess,
};
