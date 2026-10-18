// A small Web Mercator route map. OSM image tiles are optional; the route is local SVG.
const ns = "http://www.w3.org/2000/svg";
const mercator = ({ lat, lon }) => {
  const latitude = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return {
    x: (lon + 180) / 360,
    y:
      (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2,
  };
};
function node(name, attributes = {}) {
  const element = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, value);
  return element;
}

export class RouteMap {
  constructor(host, note) {
    this.host = host;
    this.note = note;
    this.points = [];
    this.center = null;
    this.zoom = 14;
    this.follow = true;
    this.tileKey = "";
    this.svg = node("svg", { role: "img", "aria-label": "Vehicle route map" });
    this.tiles = node("g", { class: "map-tiles" });
    this.path = node("path", { class: "route-line" });
    this.marker = node("circle", { r: 7, class: "route-marker" });
    this.svg.append(this.tiles, this.path, this.marker);
    host.append(this.svg);
    this.drag = null;
    host.addEventListener("pointerdown", (event) => {
      if (!this.center) return;
      this.follow = false;
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        center: { ...this.center },
      };
      host.setPointerCapture?.(event.pointerId);
    });
    host.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const scale = 256 * 2 ** this.zoom;
      this.center = {
        x: this.drag.center.x - (event.clientX - this.drag.x) / scale,
        y: this.drag.center.y - (event.clientY - this.drag.y) / scale,
      };
      this.draw();
    });
    const release = () => {
      this.drag = null;
    };
    host.addEventListener("pointerup", release);
    host.addEventListener("pointercancel", release);
    this.observer = window.ResizeObserver
      ? new ResizeObserver(() => this.draw())
      : null;
    this.observer?.observe(host);
  }
  fit() {
    this.follow = true;
    this.fitBounds();
    this.draw();
  }
  changeZoom(delta) {
    this.zoom = Math.max(3, Math.min(18, this.zoom + delta));
    this.follow = false;
    this.draw();
  }
  update(points) {
    this.points = points.filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
    );
    if (this.follow) this.fitBounds();
    this.draw();
  }
  fitBounds() {
    if (!this.points.length) {
      this.center = null;
      return;
    }
    const values = this.points.map(mercator),
      xs = values.map((p) => p.x),
      ys = values.map((p) => p.y),
      width = this.host.clientWidth || 780,
      height = this.host.clientHeight || 340;
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    this.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    this.zoom = Math.max(
      3,
      Math.min(
        16,
        Math.floor(
          Math.log2(
            Math.min(
              (width - 100) / Math.max(1e-7, maxX - minX),
              (height - 100) / Math.max(1e-7, maxY - minY),
            ) / 256,
          ),
        ),
      ),
    );
  }
  draw() {
    const width = this.host.clientWidth || 780,
      height = this.host.clientHeight || 340;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.host.classList.toggle("has-route", this.points.length > 0);
    this.marker.setAttribute(
      "visibility",
      this.points.length ? "visible" : "hidden",
    );
    if (!this.center || !this.points.length) {
      this.tiles.replaceChildren();
      this.path.setAttribute("d", "");
      this.tileKey = "";
      this.note.textContent = "Start a source to see its GPS route.";
      return;
    }
    const scale = 256 * 2 ** this.zoom,
      left = this.center.x * scale - width / 2,
      top = this.center.y * scale - height / 2;
    const coords = this.points.map((point) => {
      const p = mercator(point);
      return [p.x * scale - left, p.y * scale - top];
    });
    this.path.setAttribute(
      "d",
      coords
        .map(
          (p, index) =>
            `${index ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`,
        )
        .join(" "),
    );
    const last = coords.at(-1);
    this.marker.setAttribute("cx", last[0]);
    this.marker.setAttribute("cy", last[1]);
    const startX = Math.floor(left / 256),
      startY = Math.floor(top / 256),
      endX = Math.floor((left + width) / 256),
      endY = Math.floor((top + height) / 256);
    const key = [this.zoom, startX, startY, endX, endY].join(":");
    if (this.tileKey !== key) {
      this.tileKey = key;
      this.tiles.replaceChildren();
      this.note.textContent = "GPS route · drag to pan";
      const count = 2 ** this.zoom;
      for (let x = startX; x <= endX; x++)
        for (let y = startY; y <= endY; y++) {
          if (y < 0 || y >= count) continue;
          const tile = node("image", {
            width: 256,
            height: 256,
            "data-x": x,
            "data-y": y,
            href: `https://tile.openstreetmap.org/${this.zoom}/${((x % count) + count) % count}/${y}.png`,
          });
          tile.addEventListener("error", () => {
            if (this.tileKey === key)
              this.note.textContent =
                "Map tiles unavailable · GPS route remains visible";
          });
          this.tiles.append(tile);
        }
    }
    for (const tile of this.tiles.children) {
      tile.setAttribute("x", Number(tile.dataset.x) * 256 - left);
      tile.setAttribute("y", Number(tile.dataset.y) * 256 - top);
    }
  }
  destroy() {
    this.observer?.disconnect();
  }
}
