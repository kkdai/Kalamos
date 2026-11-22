import {
  Compartment,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { blocksExtension } from "./blocks";
import { codeBlocksExtension } from "./code-blocks";
import { diagramsExtension } from "./diagrams";
import { imagePreviewExtension } from "./images";
import { livePreviewExtension } from "./live-preview";
import { mathExtension } from "./math";
import { tableToolbarExtension } from "./table-toolbar";
import { tablePreviewStateField } from "./tables";

const richPreviewExtensions: Extension = [
  livePreviewExtension,
  codeBlocksExtension,
  mathExtension,
  tablePreviewStateField,
  tableToolbarExtension,
  imagePreviewExtension,
  diagramsExtension,
  blocksExtension,
];

export interface SourceModeController {
  extension: Extension;
  isSourceMode: () => boolean;
  setSourceMode: (view: EditorView, enabled: boolean, notify?: boolean) => void;
  toggleSourceMode: (view: EditorView) => boolean;
  /** #81: like `extension`, but for the current mode (for a newly created tab state). */
  stateExtension: () => Extension;
  /** #81: effect that brings another tab's state in line with the current mode (null = already is). */
  syncEffect: (state: EditorState) => StateEffect<unknown> | null;
}

const NO_PREVIEW: Extension = [];

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
        enabled ? NO_PREVIEW : richPreviewExtensions,
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

  const currentExtension = (): Extension =>
    sourceMode ? NO_PREVIEW : richPreviewExtensions;

  return {
    extension: compartment.of(currentExtension()),
    isSourceMode: () => sourceMode,
    setSourceMode,
    toggleSourceMode,
    stateExtension: () => compartment.of(currentExtension()),
    syncEffect: (state) =>
      compartment.get(state) === currentExtension()
        ? null
        : compartment.reconfigure(currentExtension()),
  };
}
