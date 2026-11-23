import type { DefaultEditorHost } from "./editor-host";

export function openBrowserExternalLink(url: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Web builds alias the native default to this host. Its caller supplies workspace assets. */
export const defaultEditorHost: DefaultEditorHost = {
  resolveLocalImage: () => null,
  openExternalLink: openBrowserExternalLink,
};
