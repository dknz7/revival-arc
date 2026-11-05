"""A stand-in for the downloaded VividPeek.js: its trigger lines exactly as the pinned file has them, plus a sentinel."""

PEEK_JS = """/* PEEK-SENTINEL */
(async () => {
  const ICON_CONFIG = {
    clickOpenModifiers: ["alt"],

    longPressButtons: ["middle"],

    autoOpenList: [
      "pin",
      "*.google.com",
    ],
  };
  document.addEventListener("pointerdown", (event) => {
    if (link && this.#shouldAutoOpenLinkEvent(event, link)) {
        } else if (this.#isConfiguredClickOpenModifierEvent(event)) {
    }
  });
})();
"""

PEEK_CSS = ".peek-sentinel {}"
