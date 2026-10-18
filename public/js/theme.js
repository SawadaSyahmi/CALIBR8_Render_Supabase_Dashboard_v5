const valid = (value) => ["light", "dark", "system"].includes(value);
let preference = "system";
try {
  const saved = localStorage.getItem("calibr8-theme");
  if (valid(saved)) preference = saved;
} catch {}
const media = window.matchMedia?.("(prefers-color-scheme: dark)");
export function applyTheme(value = preference) {
  if (!valid(value)) return;
  preference = value;
  document.documentElement.dataset.theme =
    value === "system" ? (media?.matches ? "dark" : "light") : value;
  document
    .querySelectorAll("[data-theme]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.theme === value),
      ),
    );
  const select = document.getElementById("themeSelect");
  if (select) select.value = value;
  try {
    localStorage.setItem("calibr8-theme", value);
  } catch {}
}
media?.addEventListener?.("change", () => {
  if (preference === "system") applyTheme();
});
window.addEventListener("storage", (event) => {
  if (event.key === "calibr8-theme" && valid(event.newValue))
    applyTheme(event.newValue);
});
