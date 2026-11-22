/**
 * #81 A: the document tab bar (shown only with two or more tabs).
 *
 * A capsule track of equal-width tabs plus a round 「＋」 button. Clicking a tab
 * selects it; the × (on hover, or in place of the unsaved dot) and a middle
 * click close it; dragging a tab sideways reorders it. The bar never takes
 * focus away from the editor.
 */
import "./tabs.css";
import { shortcutLabel } from "../platform";

export interface TabBarItem {
  id: string;
  label: string;
  /** Tooltip (the full path for saved files). */
  title: string;
  dirty: boolean;
  active: boolean;
}

export interface TabBarOptions {
  /** The bar is inserted into `parent` before `before`. */
  parent: HTMLElement;
  before?: HTMLElement | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Move tab `id` to `toIndex` (index in the list without the dragged tab). */
  onReorder?: (id: string, toIndex: number) => void;
}

export interface TabBar {
  element: HTMLElement;
  render: (items: TabBarItem[]) => void;
  isVisible: () => boolean;
  destroy: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Pointer travel before a press on a tab becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

function lineIcon(d: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

export function createTabBar(options: TabBarOptions): TabBar {
  const bar = document.createElement("div");
  bar.className = "k-tabbar";
  bar.dataset.testid = "tabbar";
  bar.dataset.visible = "false";

  const track = document.createElement("div");
  track.className = "k-tabbar-track";
  track.setAttribute("role", "tablist");
  track.setAttribute("aria-label", "文件分頁");

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "k-tabbar-new";
  newBtn.dataset.testid = "tab-new";
  newBtn.title = shortcutLabel("新增分頁（⌘T）");
  newBtn.setAttribute("aria-label", "新增分頁");
  newBtn.appendChild(lineIcon("M8 3.5v9M3.5 8h9", 16));

  bar.append(track, newBtn);
  options.parent.insertBefore(bar, options.before ?? null);

  let items: TabBarItem[] = [];
  let signature = "";
  let drag: {
    id: string;
    el: HTMLElement;
    pointerId: number;
    startX: number;
    dragging: boolean;
  } | null = null;
  let suppressClick = false;

  function scrollActiveIntoView(): void {
    const activeEl = track.querySelector<HTMLElement>(
      '.k-tab[data-active="true"]',
    );
    if (!activeEl) return;
    const left = activeEl.offsetLeft;
    const right = left + activeEl.offsetWidth;
    if (left < track.scrollLeft) {
      track.scrollLeft = left;
    } else if (right > track.scrollLeft + track.clientWidth) {
      track.scrollLeft = right - track.clientWidth;
    }
  }

  function render(next: TabBarItem[]): void {
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    items = next;
    const visible = next.length >= 2;
    bar.dataset.visible = visible ? "true" : "false";
    track.replaceChildren();
    if (!visible) return;
    for (const item of next) {
      const tab = document.createElement("div");
      tab.className = "k-tab";
      tab.dataset.testid = "tab";
      tab.dataset.tabId = item.id;
      tab.dataset.active = item.active ? "true" : "false";
      tab.dataset.dirty = item.dirty ? "true" : "false";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", item.active ? "true" : "false");
      tab.title = item.title;

      const label = document.createElement("span");
      label.className = "k-tab-label";
      label.textContent = item.label;

      const close = document.createElement("button");
      close.type = "button";
      close.className = "k-tab-close";
      close.dataset.testid = "tab-close";
      close.tabIndex = -1;
      close.setAttribute("aria-label", `關閉 ${item.label}`);
      close.title = shortcutLabel("關閉分頁（⌘W）");
      close.appendChild(lineIcon("M4.5 4.5l7 7M11.5 4.5l-7 7", 12));
      const dot = document.createElement("span");
      dot.className = "k-tab-dirty-dot";
      dot.setAttribute("aria-hidden", "true");
      close.appendChild(dot);

      tab.append(label, close);
      track.appendChild(tab);
    }
    scrollActiveIntoView();
  }

  function tabFromEvent(event: Event): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(".k-tab");
  }

  /** Index (among the other tabs) the dragged tab would land at for this pointer x. */
  function dropIndexAt(clientX: number, draggedId: string): number {
    const others = Array.from(
      track.querySelectorAll<HTMLElement>(".k-tab"),
    ).filter((el) => el.dataset.tabId !== draggedId);
    let index = 0;
    for (const el of others) {
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
    }
    return index;
  }

  const onMouseDown = (event: MouseEvent) => {
    // Keep the editor's focus and selection; the middle button must not start autoscroll.
    if (
      tabFromEvent(event) ||
      event.target === newBtn ||
      newBtn.contains(event.target as Node)
    ) {
      event.preventDefault();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const tab = tabFromEvent(event);
    if (!tab || (event.target as Element).closest(".k-tab-close")) return;
    drag = {
      id: tab.dataset.tabId!,
      el: tab,
      pointerId: event.pointerId,
      startX: event.clientX,
      dragging: false,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId || !options.onReorder)
      return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      drag.el.dataset.dragging = "true";
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events have no active pointer.
      }
    }
    drag.el.style.transform = `translateX(${dx}px)`;
  };

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    if (!current.dragging) return;
    current.el.style.transform = "";
    delete current.el.dataset.dragging;
    suppressClick = true;
    if (event.type === "pointerup") {
      const from = items.findIndex((item) => item.id === current.id);
      const to = dropIndexAt(event.clientX, current.id);
      if (from >= 0 && to !== from) options.onReorder?.(current.id, to);
    }
  };

  const onClick = (event: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const tab = tabFromEvent(event);
    if (!tab) return;
    const id = tab.dataset.tabId!;
    if ((event.target as Element).closest(".k-tab-close")) {
      options.onClose(id);
    } else {
      options.onSelect(id);
    }
  };

  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    const tab = tabFromEvent(event);
    if (!tab) return;
    event.preventDefault();
    options.onClose(tab.dataset.tabId!);
  };

  const onNewClick = () => options.onNew();

  bar.addEventListener("mousedown", onMouseDown);
  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  track.addEventListener("click", onClick);
  track.addEventListener("auxclick", onAuxClick);
  newBtn.addEventListener("click", onNewClick);

  return {
    element: bar,
    render,
    isVisible: () => bar.dataset.visible === "true",
    destroy: () => {
      bar.removeEventListener("mousedown", onMouseDown);
      track.removeEventListener("pointerdown", onPointerDown);
      track.removeEventListener("pointermove", onPointerMove);
      track.removeEventListener("pointerup", endDrag);
      track.removeEventListener("pointercancel", endDrag);
      track.removeEventListener("click", onClick);
      track.removeEventListener("auxclick", onAuxClick);
      newBtn.removeEventListener("click", onNewClick);
      bar.remove();
    },
  };
}
