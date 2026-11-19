import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { codeBlocksExtension } from "./code-blocks";
import { imagePreviewExtension } from "./images";
import { livePreviewExtension } from "./live-preview";
import { mathExtension } from "./math";
import { tablePreviewStateField } from "./tables";

const richPreviewExtensions: Extension = [
  livePreviewExtension,
  codeBlocksExtension,
  mathExtension,
  tablePreviewStateField,
  imagePreviewExtension,
];

export interface SourceModeController {
  extension: Extension;
  isSourceMode: () => boolean;
  setSourceMode: (view: EditorView, enabled: boolean, notify?: boolean) => void;
  toggleSourceMode: (view: EditorView) => boolean;
}

export function createSourceModeController(options?: {
  initialSourceMode?: boolean;
  onSourceModeChange?: (sourceMode: boolean) => void;
}): SourceModeController {
  const compartment = new Compartment();
  let sourceMode = Boolean(options?.initialSourceMode);

  function setSourceMode(
    view: EditorView,
    enabled: boolean,
    notify = false,
  ): void {
    sourceMode = enabled;
    view.dispatch({
      effects: compartment.reconfigure(enabled ? [] : richPreviewExtensions),
    });
    if (notify) {
      options?.onSourceModeChange?.(sourceMode);
    }
  }

  function toggleSourceMode(view: EditorView): boolean {
    setSourceMode(view, !sourceMode, true);
    return sourceMode;
  }

  return {
    extension: compartment.of(sourceMode ? [] : richPreviewExtensions),
    isSourceMode: () => sourceMode,
    setSourceMode,
    toggleSourceMode,
  };
}
