// Blocking FOUC helper: apply stored (or system) theme before first paint.
try {
  const stored = localStorage.getItem("planning-poker-theme");
  const dark =
    stored === "dark" ||
    (stored !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) {
    document.documentElement.dataset.theme = "dark";
  }
} catch {
  /* private mode / blocked storage */
}
