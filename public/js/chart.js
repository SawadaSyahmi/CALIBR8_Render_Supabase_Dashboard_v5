import { number } from "./format.js";

export function renderChart(element, rows) {
  const width = 760,
    height = 190,
    left = 43,
    right = 44,
    top = 16,
    bottom = 27;
  const w = width - left - right,
    h = height - top - bottom;
  const valid = rows.filter(
    (row) => Number.isFinite(row.speed) && Number.isFinite(row.decel),
  );
  if (!valid.length) {
    element.innerHTML =
      '<div class="chart-empty">Your speed and braking history will appear here.</div>';
    return;
  }
  const maxSpeed = Math.max(
    20,
    Math.ceil(Math.max(...valid.map((row) => row.speed)) / 20) * 20,
  );
  const maxDecel = Math.max(
    2,
    Math.ceil(Math.max(...valid.map((row) => row.decel)) / 2) * 2,
  );
  const x = (index) => left + (index / Math.max(1, valid.length - 1)) * w;
  const path = (key, max) =>
    valid
      .map(
        (row, index) =>
          `${index ? "L" : "M"}${x(index).toFixed(2)},${(top + h - (row[key] / max) * h).toFixed(2)}`,
      )
      .join(" ");
  let grid = "";
  for (let index = 0; index <= 4; index++) {
    const y = top + (h * index) / 4;
    grid += `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="chart-gridline"/><text x="${left - 9}" y="${y + 4}" text-anchor="end">${number(maxSpeed * (1 - index / 4), 0)}</text><text x="${width - right + 9}" y="${y + 4}">${number(maxDecel * (1 - index / 4), 1)}</text>`;
  }
  element.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Speed and estimated peak deceleration over the last ${valid.length} samples"><g class="chart-labels">${grid}<text x="${left}" y="${height - 4}">Earlier</text><text x="${width - right}" y="${height - 4}" text-anchor="end">Latest</text></g><path d="${path("speed", maxSpeed)}" class="speed-line"/><path d="${path("decel", maxDecel)}" class="decel-line"/>${valid.length === 1 ? `<circle cx="${left}" cy="${top + h - (valid[0].speed / maxSpeed) * h}" r="3" fill="var(--accent)"/>` : ""}</svg>`;
}
