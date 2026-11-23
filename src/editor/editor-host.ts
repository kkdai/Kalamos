import { Facet } from "@codemirror/state";

export type LocalImageResolver = (resolvedPath: string) => string | null;

/** Platform services used by live preview. An injected host replaces the native defaults. */
export interface EditorHost {
  /** Receives a resolved slash path, not the raw Markdown. Return null if it is unavailable. */
  resolveLocalImage: LocalImageResolver;
  /** Receives only allowed external URLs (HTTP, HTTPS, and mailto). */
  openExternalLink: (url: string) => void | Promise<void>;
}

export const editorHostFacet = Facet.define<EditorHost>();

/** File permissions are only needed by the native default host. */
export interface ImageAssetAccess {
  isFileAllowed: (path: string) => boolean;
  ensureFileAllowed: (path: string) => Promise<boolean>;
  resetFileCache: () => void;
  allowRoot: (root: string, onRefused: () => void) => void;
}

export type DefaultEditorHost = EditorHost & { assetAccess?: ImageAssetAccess };
