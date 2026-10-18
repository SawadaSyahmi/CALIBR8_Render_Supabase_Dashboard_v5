export const number = (value, decimals = 1) =>
  value === null ||
  value === undefined ||
  value === "" ||
  !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toFixed(decimals);
export const words = (value) =>
  value ? String(value).replaceAll("_", " ") : "—";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export const time = (value) => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
};
export function csv(rows) {
  const columns = [
    "timestamp",
    "model",
    "mode",
    "probability",
    "speed_kmh",
    "peak_decel_mps2",
    "physics_label",
    "utilisation",
    "lat",
    "lon",
  ];
  const quote = (value) =>
    '"' + String(value ?? "").replaceAll('"', '""') + '"';
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => quote(row[key])).join(",")),
  ].join("\r\n");
}
