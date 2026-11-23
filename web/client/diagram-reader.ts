import "./diagram-reader.css";

export function createDiagramReader(dialog: HTMLDialogElement) {
  function find<T extends HTMLElement>(selector: string) {
    const node = dialog.querySelector<T>(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    return node;
  }

  const stage = find("#diagram-reader-stage");
  const imageButton = find<HTMLButtonElement>("#diagram-reader-image");
  const image = find<HTMLImageElement>("#diagram-reader-image img");
  const stageStyle = getComputedStyle(stage);
  const maximum = 4;
  let width = 1;
  let height = 1;
  let scale = 1;
  let fitting = false;
  let objectUrl = "";

  function fitScale() {
    return Math.min(
      2,
      Math.max(1, parseFloat(stageStyle.maxWidth)) / width,
      Math.max(1, parseFloat(stageStyle.maxHeight)) / height,
    );
  }

  function renderScale(next: number, recenter = false) {
    const minimum = Math.min(0.1, fitScale());
    const center = (size: number, visible: number, offset: number) =>
      size > visible ? (offset + visible / 2) / size : 0.5;
    const x = center(image.clientWidth, stage.clientWidth, stage.scrollLeft);
    const y = center(image.clientHeight, stage.clientHeight, stage.scrollTop);
    scale = Math.max(minimum, Math.min(maximum, next));
    image.style.width = `${width * scale}px`;
    image.style.height = `${height * scale}px`;
    if (recenter) {
      stage.scrollTo(0, 0);
    } else {
      stage.scrollTo(
        image.clientWidth * x - stage.clientWidth / 2,
        image.clientHeight * y - stage.clientHeight / 2,
      );
    }
  }

  function fitToWindow() {
    fitting = true;
    renderScale(fitScale(), true);
  }

  function zoom(multiplier: number) {
    fitting = false;
    renderScale(scale * multiplier);
  }

  stage.addEventListener("keydown", (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (event.key !== "+" && event.key !== "-") return;
    event.preventDefault();
    zoom(event.key === "+" ? 1.25 : 0.8);
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey || !event.cancelable) return;
      const mode = event.deltaMode;
      const unit =
        mode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : mode === WheelEvent.DOM_DELTA_PAGE
            ? stage.clientHeight
            : 1;
      if (event.deltaY === 0) return;
      event.preventDefault();
      zoom(Math.exp(-0.002 * event.deltaY * unit));
    },
    { passive: false },
  );
  imageButton.addEventListener("click", () => dialog.close());
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      if (
        event.clientX < left ||
        event.clientX > right ||
        event.clientY < top ||
        event.clientY > bottom
      ) {
        dialog.close();
      }
    });
  }

  function clearImage() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    image.removeAttribute("src");
  }
  dialog.addEventListener("close", () => {
    if (!dialog.open) clearImage();
  });
  window.addEventListener("resize", () => {
    if (dialog.open && fitting) fitToWindow();
  });

  return (svg: SVGSVGElement) => {
    if (dialog.open) return;
    const box = svg.viewBox.baseVal;
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height)
    )
      return;
    width = box.width;
    height = box.height;
    scale = 1;
    clearImage();

    // Reuse the sanitized render as an image, not as a second set of DOM IDs.
    const graphic = svg.cloneNode(true) as SVGSVGElement;
    graphic.style.removeProperty("width");
    graphic.style.removeProperty("max-width");
    graphic.setAttribute("width", String(width));
    graphic.setAttribute("height", String(height));
    objectUrl = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(graphic)], {
        type: "image/svg+xml",
      }),
    );
    image.src = objectUrl;
    dialog.showModal();
    fitToWindow();
  };
}
