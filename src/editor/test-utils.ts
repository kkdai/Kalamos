import { ensureSyntaxTree, forceParsing } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Forces Lezer to parse the entire document and commits the completed tree
 * onto the returned `EditorState`, so `syntaxTree(state)` and all StateFields
 * observe the full syntax tree regardless of CPU speed.
 *
 * `ensureSyntaxTree` only populates the parser's mutable `ParseContext.tree`
 * without mutating the immutable `EditorState` field; dispatching an empty
 * transaction (`state.update({}).state`) commits the new tree onto the state.
 */
export function ensureFullSyntaxTree(
  state: EditorState,
  timeout = 5000,
): EditorState {
  if (!ensureSyntaxTree(state, state.doc.length, timeout)) {
    throw new Error(
      `Syntax tree did not finish parsing (${state.doc.length} chars) within ${timeout}ms`,
    );
  }
  return state.update({}).state;
}

/**
 * Forces Lezer to parse the entire document in an `EditorView` and dispatches
 * an update if the tree advanced, so `syntaxTree(view.state)` and all
 * ViewPlugins / StateFields observe the full syntax tree.
 */
export function forceFullParsing(view: EditorView, timeout = 5000): void {
  if (!forceParsing(view, view.state.doc.length, timeout)) {
    throw new Error(
      `Syntax tree did not finish parsing (${view.state.doc.length} chars) within ${timeout}ms`,
    );
  }
}
