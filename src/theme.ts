/** Also read by `public/theme-init.js`. */
const THEME_KEY = "planning-poker-theme";

export function isDarkTheme(): boolean {
  return document.documentElement.dataset["theme"] === "dark";
}

/** Reflect the theme in the document and the toggle. Which icon shows is CSS's job. */
function renderTheme(dark: boolean, button: HTMLButtonElement): void {
  if (dark) {
    document.documentElement.dataset["theme"] = "dark";
  } else {
    delete document.documentElement.dataset["theme"];
  }
  button.setAttribute(
    "aria-label",
    dark ? "Switch to light theme" : "Switch to dark theme",
  );
  button.title = dark ? "Light theme" : "Dark theme";
}

export function initTheme(button: HTMLButtonElement): void {
  renderTheme(isDarkTheme(), button);
  button.addEventListener("click", () => {
    const dark = !isDarkTheme();
    renderTheme(dark, button);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      /* private mode / blocked storage */
    }
  });
}
