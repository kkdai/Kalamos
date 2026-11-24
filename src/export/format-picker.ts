import "./format-picker.css";

import { t } from "../i18n";
import { PANDOC_FORMATS, type PandocFormat } from "./pandoc";

/**
 * Small modal listing the Pandoc export formats (EX-02). Resolves with the
 * chosen format, or null on Escape / 取消 / a click outside. Built with
 * textContent only (no HTML strings).
 */
export function pickExportFormat(
  doc: Document = document,
): Promise<PandocFormat | null> {
  doc.querySelector(".k-format-picker-backdrop")?.remove();
  return new Promise((resolve) => {
    const previousFocus = doc.activeElement as HTMLElement | null;
    const backdrop = doc.createElement("div");
    backdrop.className = "k-format-picker-backdrop";

    const panel = doc.createElement("div");
    panel.className = "k-format-picker";
    panel.dataset.testid = "export-format-picker";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", t("export.pandoc.pickerTitle"));

    const title = doc.createElement("div");
    title.className = "k-format-picker-title";
    title.textContent = t("export.pandoc.pickerTitle");
    panel.append(title);

    let settled = false;
    const finish = (value: PandocFormat | null): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      previousFocus?.focus?.();
      resolve(value);
    };

    const buttons: HTMLButtonElement[] = [];
    for (const format of PANDOC_FORMATS) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "k-format-option";
      btn.dataset.format = format.id;
      btn.dataset.testid = `export-format-${format.id}`;
      const label = doc.createElement("span");
      label.textContent = format.label;
      const desc = doc.createElement("span");
      desc.className = "k-format-option-desc";
      desc.textContent = t(format.descriptionKey);
      btn.append(label, desc);
      btn.addEventListener("click", () => finish(format.id));
      buttons.push(btn);
      panel.append(btn);
    }

    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "k-format-cancel";
    cancel.dataset.testid = "export-format-cancel";
    cancel.textContent = t("editor.dialog.cancel");
    cancel.addEventListener("click", () => finish(null));
    panel.append(cancel);

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const idx = buttons.indexOf(doc.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = (idx + step + buttons.length) % buttons.length;
        buttons[idx < 0 ? 0 : next].focus();
      }
    };
    doc.addEventListener("keydown", onKeydown, true);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) finish(null);
    });

    backdrop.append(panel);
    doc.body.append(backdrop);
    buttons[0]?.focus();
  });
}
