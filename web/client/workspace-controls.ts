export type WorkspaceView = "tree" | "list" | "outline" | "search" | "trash";

export function bindWorkspaceControls(
  onViewChange: (view: WorkspaceView) => void,
) {
  const sidebar = document.querySelector<HTMLElement>("#workspace-sidebar");
  const sidebarToggle =
    document.querySelector<HTMLButtonElement>("#toggle-sidebar");
  const layout = document.querySelector<HTMLElement>(".workspace-layout");
  const switchers = document.querySelectorAll<HTMLButtonElement>(
    "#workspace-view [data-view]",
  );
  const panel = document.querySelector<HTMLElement>("#file-actions");
  const trigger = document.querySelector<HTMLButtonElement>(
    "#file-actions-trigger",
  );
  if (!sidebar || !sidebarToggle || !layout || !panel || !trigger) return;

  const setSidebarOpen = (open: boolean) => {
    sidebar.hidden = !open;
    layout.dataset.sidebar = open ? "open" : "closed";
    sidebarToggle.setAttribute("aria-expanded", String(open));
  };

  setSidebarOpen(!matchMedia("(max-width: 40rem)").matches);
  sidebarToggle.addEventListener("click", () => setSidebarOpen(sidebar.hidden));
  for (const control of switchers) {
    control.addEventListener("click", () => {
      const view = control.dataset.view;
      if (
        view !== "tree" &&
        view !== "list" &&
        view !== "outline" &&
        view !== "search" &&
        view !== "trash"
      )
        return;
      for (const item of switchers)
        item.setAttribute("aria-pressed", String(item === control));
      onViewChange(view);
    });
  }

  const nativePopover = "showPopover" in HTMLElement.prototype;
  const setExpanded = (open: boolean) =>
    trigger.setAttribute("aria-expanded", String(open));
  const close = () => {
    const focusInside = panel.contains(document.activeElement);
    if (nativePopover) panel.hidePopover();
    else panel.hidden = true;
    setExpanded(false);
    if (focusInside) trigger.focus();
  };

  setExpanded(false);
  if (nativePopover) {
    panel.addEventListener("toggle", () =>
      setExpanded(panel.matches(":popover-open")),
    );
  } else {
    panel.hidden = true;
    trigger.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      setExpanded(!panel.hidden);
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        event.target instanceof Node &&
        !panel.hidden &&
        !panel.contains(event.target) &&
        !trigger.contains(event.target)
      )
        close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) close();
    });
  }
  panel.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button"))
      close();
  });
}
