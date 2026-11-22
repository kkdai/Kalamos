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

  const applyRecommendedPlatform = (platform) => {
    if (!platform) return;
    document.querySelectorAll("[data-download-group]").forEach((group) => {
      group.setAttribute("data-detected-platform", platform);
      group.querySelectorAll("[data-platform]").forEach((btn) => {
        const isMatch = btn.getAttribute("data-platform") === platform;
        btn.classList.toggle("is-recommended", isMatch);
      });
    });
  };

  const detectMacArchViaWebGL = () => {
    try {
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return null;
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (!debugInfo) return null;
      const renderer = String(
        gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || ""
      );
      if (/Apple\s*(M\d|GPU)/i.test(renderer)) return "macos-arm";
      if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return "macos-intel";
    } catch {
      // Ignore WebGL restrictions.
    }
    return null;
  };

  const detectPlatform = async () => {
    const nav = window.navigator;
    if (!nav) return null;

    const ua = nav.userAgent || "";
    const legacyPlatform = nav.platform || "";

    // Leave mobile/tablet devices in equal-weight mode so all desktop downloads stay visible.
    if (
      /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
      (/Mac/i.test(legacyPlatform) && nav.maxTouchPoints > 1)
    ) {
      return null;
    }

    const uaData = nav.userAgentData;
    if (uaData) {
      if (uaData.mobile) return null;
      const p = (uaData.platform || "").toLowerCase();
      if (p === "windows") return "windows";
      if (p === "macos") {
        if (typeof uaData.getHighEntropyValues === "function") {
          try {
            const hints = await uaData.getHighEntropyValues(["architecture"]);
            const arch = (hints.architecture || "").toLowerCase();
            if (arch === "arm") return "macos-arm";
            if (arch === "x86") return "macos-intel";
          } catch {
            // Fall through to WebGL heuristic.
          }
        }
        return detectMacArchViaWebGL();
      }
      if (p) return null;
    }

    if (/Win/i.test(legacyPlatform) || /Windows/i.test(ua)) {
      return "windows";
    }
    if (/Mac/i.test(legacyPlatform) || /Macintosh|Mac OS X/i.test(ua)) {
      return detectMacArchViaWebGL();
    }

    return null;
  };

  detectPlatform().then(applyRecommendedPlatform);
})();
