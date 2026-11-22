import "./table-toolbar.css";

import type { EditorView } from "@codemirror/view";
import {
  clampInt,
  insertTable,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
} from "./table-ops";

/**
 * #59 B: 「插入表格」 dialog (Cmd+Opt+T). Rows (header included) and columns
 * via two number fields or a hover grid picker; default 3 × 3. Resolves with
 * the size, or null on Escape / 取消 / a click outside. Built with DOM APIs
 * only (no HTML strings).
 */

export interface TableSize {
  rows: number;
  cols: number;
}

export const DEFAULT_TABLE_SIZE: TableSize = { rows: 3, cols: 3 };
const PICKER_ROWS = 8;
const PICKER_COLS = 10;

export function pickTableSize(
  doc: Document = document,
  initial: TableSize = DEFAULT_TABLE_SIZE,
): Promise<TableSize | null> {
  doc.querySelector(".k-table-dialog-backdrop")?.remove();
  return new Promise((resolve) => {
    const backdrop = doc.createElement("div");
    backdrop.className = "k-table-dialog-backdrop";

    const panel = doc.createElement("form");
    panel.className = "k-table-dialog";
    panel.noValidate = true; // out-of-range values are clamped, not rejected
    panel.dataset.testid = "table-insert-dialog";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "插入表格");

    const title = doc.createElement("div");
    title.className = "k-table-dialog-title";
    title.textContent = "插入表格";

    const field = (
      label: string,
      value: number,
      max: number,
      testid: string,
    ) => {
      const wrap = doc.createElement("label");
      wrap.className = "k-table-dialog-field";
      const text = doc.createElement("span");
      text.textContent = label;
      const input = doc.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = String(max);
      input.step = "1";
      input.value = String(value);
      input.dataset.testid = testid;
      wrap.append(text, input);
      return { wrap, input };
    };
    const rowsField = field(
      "列數（含表頭）",
      initial.rows,
      MAX_TABLE_ROWS,
      "table-dialog-rows",
    );
    const colsField = field(
      "欄數",
      initial.cols,
      MAX_TABLE_COLS,
      "table-dialog-cols",
    );
    const fields = doc.createElement("div");
    fields.className = "k-table-dialog-fields";
    fields.append(rowsField.wrap, colsField.wrap);

    // Grid picker: hover to preview a size, click to insert it.
    const picker = doc.createElement("div");
    picker.className = "k-table-picker";
    picker.dataset.testid = "table-dialog-picker";
    picker.style.gridTemplateColumns = `repeat(${PICKER_COLS}, 1fr)`;
    const pickerCells: HTMLElement[] = [];
    for (let r = 1; r <= PICKER_ROWS; r++) {
      for (let c = 1; c <= PICKER_COLS; c++) {
        const cell = doc.createElement("div");
        cell.className = "k-table-picker-cell";
        cell.dataset.rows = String(r);
        cell.dataset.cols = String(c);
        pickerCells.push(cell);
        picker.append(cell);
      }
    }
    const sizeLabel = doc.createElement("div");
    sizeLabel.className = "k-table-picker-label";

    const highlight = (rows: number, cols: number) => {
      for (const cell of pickerCells) {
        const on =
          Number(cell.dataset.rows) <= rows &&
          Number(cell.dataset.cols) <= cols;
        cell.classList.toggle("is-selected", on);
      }
      sizeLabel.textContent = `${rows} 列 × ${cols} 欄`;
    };
    const currentSize = (): TableSize => ({
      rows: clampInt(Number(rowsField.input.value), 1, MAX_TABLE_ROWS),
      cols: clampInt(Number(colsField.input.value), 1, MAX_TABLE_COLS),
    });
    const syncFromFields = () => {
      const { rows, cols } = currentSize();
      highlight(rows, cols);
    };
    rowsField.input.addEventListener("input", syncFromFields);
    colsField.input.addEventListener("input", syncFromFields);
    picker.addEventListener("mouseover", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>(
        ".k-table-picker-cell",
      );
      if (cell) highlight(Number(cell.dataset.rows), Number(cell.dataset.cols));
    });
    picker.addEventListener("mouseleave", syncFromFields);
    picker.addEventListener("click", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>(
        ".k-table-picker-cell",
      );
      if (cell)
        finish({
          rows: Number(cell.dataset.rows),
          cols: Number(cell.dataset.cols),
        });
    });

    const actions = doc.createElement("div");
    actions.className = "k-table-dialog-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.dataset.testid = "table-dialog-cancel";
    cancel.addEventListener("click", () => finish(null));
    const ok = doc.createElement("button");
    ok.type = "submit";
    ok.className = "is-primary";
    ok.textContent = "插入";
    ok.dataset.testid = "table-dialog-ok";
    actions.append(cancel, ok);

    panel.append(title, fields, picker, sizeLabel, actions);
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(currentSize());
    });

    let settled = false;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };
    function finish(value: TableSize | null): void {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      resolve(value);
    }
    doc.addEventListener("keydown", onKeydown, true);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) finish(null);
    });

    backdrop.append(panel);
    doc.body.append(backdrop);
    syncFromFields();
    rowsField.input.focus();
    rowsField.input.select();
  });
}

/** Open the dialog and insert the chosen table at the cursor. */
export async function openInsertTableDialog(
  view: EditorView,
): Promise<boolean> {
  if (view.state.readOnly) return false;
  const size = await pickTableSize(view.dom.ownerDocument);
  view.focus();
  if (!size) return false;
  return insertTable(view, size.rows, size.cols);
}
