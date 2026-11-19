import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { livePreviewExtension } from "./live-preview";
import { tablePreviewStateField } from "./tables";

const activeLivePreviewExtensions = [
  ...livePreviewExtension,
  tablePreviewStateField,
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
      effects: compartment.reconfigure(
        enabled ? [] : activeLivePreviewExtensions,
      ),
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
    extension: compartment.of(sourceMode ? [] : activeLivePreviewExtensions),
    isSourceMode: () => sourceMode,
    setSourceMode,
    toggleSourceMode,
  };
}
