(() => {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      if (!text) return;
      const original = btn.textContent;
      const doneLabel = btn.getAttribute("data-copied-label") || "Copied";
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = doneLabel;
        window.setTimeout(() => {
          btn.textContent = original;
        }, 1600);
      } catch {
        // Clipboard unavailable in insecure contexts; leave text selectable.
      }
    });
  });
})();
