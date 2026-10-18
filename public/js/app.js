import { Api } from "./api.js";
import { Controller } from "./controller.js";
import { createStore } from "./store.js";
import { number, words, time, escape, csv } from "./format.js";
import { applyTheme } from "./theme.js";
import { renderChart } from "./chart.js";
import { RouteMap } from "./map.js";

const titles = {
  overview: [
    "Overview",
    "Fleet overview",
    "A clear view of your vehicle, its journey, and every braking signal.",
  ],
  fleet: [
    "Fleet & connections",
    "Your connected fleet",
    "Bring your vehicle APIs together in one workspace.",
  ],
  events: [
    "Safety events",
    "Safety events",
    "Review the braking events recorded in your selected session.",
  ],
  models: [
    "Models & physics",
    "Understand the decision",
    "Compare both AI models and inspect the physics behind each measurement.",
  ],
  data: [
    "API output",
    "Explore your data",
    "Inspect the source response and the complete measurement snapshot.",
  ],
  settings: [
    "Workspace settings",
    "Workspace settings",
    "Personalize your workspace and check its connections.",
  ],
};
const names = {
  sample: "Recorded sample",
  synthetic: "Synthetic drive",
  fleet: "Live fleet",
  device: "Device feed",
  legacy: "Legacy API feed",
};

export function createApp() {
  const store = createStore(),
    api = new Api(),
    controller = new Controller(api, store);
  const get = (id) => document.getElementById(id);
  const text = (id, value) => {
    const target = get(id);
    const content = String(value ?? "");
    if (target.textContent !== content) target.textContent = content;
  };
  const visible = (id, value) => {
    get(id).hidden = !value;
  };
  const notice = (id, message, kind = "error") => {
    text(id, message);
    get(id).className = "notice " + kind;
    visible(id, Boolean(message));
  };
  let toastTimer = null,
    lastRoute = null,
    lastChart = null,
    restoreFocus = null;
  const map = new RouteMap(get("routeMap"), get("mapNote"));
  function toast(message) {
    text("toast", message);
    visible("toast", true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => visible("toast", false), 4200);
  }
  function safe(action) {
    return async (event) => {
      try {
        await action(event);
      } catch (error) {
        if (error.name !== "AbortError") toast(error.message);
      }
    };
  }
  function closeMenu() {
    get("sidebar").classList.remove("open");
    get("sidebarScrim").hidden = true;
    get("menuButton").setAttribute("aria-expanded", "false");
  }
  function closeDialog() {
    if (typeof get("connectionDialog").close === "function")
      get("connectionDialog").close();
    else get("connectionDialog").removeAttribute("open");
    restoreFocus?.focus();
    restoreFocus = null;
  }
  function openConnection(connection = null) {
    restoreFocus = document.activeElement;
    get("connectionForm").reset();
    get("advancedConnection").open = false;
    get("connectionId").value = connection?.connection_id || "";
    text(
      "connectionTitle",
      connection ? "Edit API connection" : "Add API connection",
    );
    get("connectionName").value = connection?.name || "";
    get("connectionUrl").value = connection?.url || "";
    get("connectionHeaders").value = "";
    get("rootPath").value = connection?.root_path || "";
    get("pollInterval").value = connection?.poll_interval_sec || 5;
    get("speedUnit").value = connection?.speed_unit || "kmh";
    get("timestampFormat").value =
      connection?.timestamp_format || "epoch_seconds";
    const mapping = {
      device_id: ["mapDevice", "deviceId"],
      timestamp: ["mapTimestamp", "dateTime"],
      latitude: ["mapLat", "latitude"],
      longitude: ["mapLon", "longitude"],
      speed: ["mapSpeed", "speed"],
      direction: ["mapDirection", "direction"],
    };
    for (const [key, [id, fallback]] of Object.entries(mapping))
      get(id).value = connection?.field_mapping?.[key] ?? fallback;
    const context = connection?.default_context || {};
    for (const [key, id, fallback] of [
      ["vehicle_type", "ctxVehicle", "passenger_car"],
      ["road_type", "ctxRoad", "urban"],
      ["traffic_density", "ctxTraffic", "medium"],
      ["weather", "ctxWeather", "clear"],
      ["road_surface", "ctxSurface", "dry_asphalt"],
    ])
      get(id).value = context[key] || fallback;
    get("ctxGrade").value = number((context.road_grade_ratio || 0) * 100, 1);
    get("connectionEnabled").checked = connection?.enabled !== false;
    text(
      "headerHelp",
      connection?.has_headers
        ? "Headers are saved. Leave blank to keep them, or enter {} to clear them."
        : "Optional. Use an empty object to clear saved headers.",
    );
    notice("connectionMessage", "");
    if (typeof get("connectionDialog").showModal === "function")
      get("connectionDialog").showModal();
    else get("connectionDialog").setAttribute("open", "");
    get("connectionName").focus();
  }

  function renderConnections(s) {
    notice("connectionsError", s.connectionError);
    if (s.connectionsLoading && !s.connections.length) {
      get("connectionList").innerHTML =
        '<div class="empty-state">Loading your saved connections…</div>';
      return;
    }
    get("connectionList").innerHTML = s.connections.length
      ? s.connections
          .map(
            (c) =>
              `<article class="connection-card"><div class="connection-card-top"><h3>${escape(c.name)}</h3><span class="pill ${c.enabled ? "" : "neutral"}">${c.enabled ? "Enabled" : "Disabled"}</span></div><p class="connection-url">${escape(c.url)}</p><div class="connection-meta"><span>Every ${escape(c.poll_interval_sec)} s</span><span>${c.has_headers ? "Encrypted headers" : "No request headers"}</span><span>${escape(c.speed_unit === "kmh" ? "km/h" : c.speed_unit)}</span></div><div class="connection-actions"><button class="text-button" type="button" data-test="${escape(c.connection_id)}">Test connection</button><button class="text-button" type="button" data-edit="${escape(c.connection_id)}">Edit</button><button class="text-button remove" type="button" data-remove="${escape(c.connection_id)}">Remove</button></div></article>`,
          )
          .join("")
      : '<div class="empty-state"><strong>Connect your first vehicle API</strong><span>You can save several feeds and monitor vehicles from any of them.</span><button class="button secondary" type="button" data-action="add-connection">Add API connection</button></div>';
  }
  function renderFleet(s) {
    const query = get("fleetSearch").value.trim().toLowerCase();
    const rows = s.vehicles.filter((v) =>
      (v.external_vehicle_id + " " + v.connection_name)
        .toLowerCase()
        .includes(query),
    );
    text("fleetTotal", s.vehicles.length);
    text("navFleetCount", s.vehicles.length);
    notice("fleetError", s.fleetError);
    get("discoverButton").disabled = s.fleetLoading;
    text("discoverButton", s.fleetLoading ? "Refreshing…" : "Refresh fleet");
    get("sourceFleetRefresh").disabled = s.fleetLoading;
    get("discoveryStatus").innerHTML = s.connectionResults
      .map(
        (result) =>
          `<div class="discovery-item ${result.status?.ok ? "" : "bad"}"><strong>${escape(result.name)}</strong> · ${result.status?.ok ? `${result.vehicles.length} vehicle${result.vehicles.length === 1 ? "" : "s"} found` : escape(result.status?.message || "Request failed")}</div>`,
      )
      .join("");
    get("vehicleList").innerHTML = rows.length
      ? rows
          .map(
            (v) =>
              `<article class="vehicle-card ${s.source === "fleet" && s.vehicleId === v.internal_vehicle_id ? "active" : ""}"><h3>${escape(v.external_vehicle_id)}</h3><p>${escape(v.connection_name)}</p><div class="vehicle-stats"><span>${number(v.speed_kmh)} km/h</span><span>${time(v.source_timestamp)}</span></div><button class="button secondary" type="button" data-monitor="${escape(v.internal_vehicle_id)}">Monitor vehicle →</button></article>`,
          )
          .join("")
      : `<div class="empty-state"><strong>${s.fleetLoading ? "Discovering your vehicles…" : query ? "No matching vehicles" : "No vehicles discovered yet"}</strong><span>${query ? "Try another vehicle ID or connection name." : "Add a connection and refresh the fleet, or start with the sample replay."}</span>${!query && !s.fleetLoading ? '<button class="button secondary" type="button" data-action="run-sample">Run sample replay</button>' : ""}</div>`;
  }
  function renderEvents(s) {
    const query = get("eventSearch").value.trim().toLowerCase();
    const rows = s.events
      .slice()
      .reverse()
      .filter((e) =>
        [e.timestamp, e.model, words(e.physics_label), e.lat, e.lon]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    text(
      "eventsTotal",
      query ? `${rows.length} / ${s.events.length}` : s.events.length,
    );
    text("navEventCount", s.events.length);
    get("exportButton").disabled = !s.events.length;
    get("eventRows").innerHTML = rows.length
      ? rows
          .map(
            (e) =>
              `<tr><td>${time(e.timestamp)}</td><td>${e.model_key === "friend_gbm" ? "Friend GBM" : "CALIBR8-AI"}</td><td><span class="pill danger">${number(e.probability * 100, 1)}%</span></td><td>${number(e.speed_kmh)} km/h</td><td>${number(e.peak_decel_mps2, 2)} m/s²</td><td>${escape(words(e.physics_label))} · ${number(e.utilisation * 100, 0)}%</td><td>${number(e.lat, 5)}, ${number(e.lon, 5)}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="7" class="empty-cell">${query ? "No events match your search." : "No harsh events recorded. Run a sample and inject a harsh event to test detection."}</td></tr>`;
    text(
      "eventsNote",
      ["sample", "synthetic"].includes(s.source)
        ? "Sample events belong to this session. Export them before starting a new session."
        : "Showing up to 1,000 recent events in the current trip. Live events are saved when the database is available.",
    );
  }
  function renderModels(frame) {
    const models = frame?.models || {};
    get("modelComparison").innerHTML = [
      ["new_ai", "CALIBR8-AI ensemble", "60% XGBoost + 40% LightGBM"],
      ["friend_gbm", "Friend GBM", "Four-class HistGradientBoosting"],
    ]
      .map(([key, name, description]) => {
        const m = models[key],
          percentage = m
            ? Math.max(0, Math.min(100, m.probability_harsh * 100))
            : 0;
        const components = m?.components
          ? `XGBoost ${number(m.components.xgboost_probability * 100, 1)}% · LightGBM ${number(m.components.lightgbm_probability * 100, 1)}% · threshold ${number(m.threshold, 3)}`
          : m?.class_probabilities
            ? Object.entries(m.class_probabilities)
                .map(
                  ([label, p]) =>
                    `${escape(words(label))}: ${number(p * 100, 1)}%`,
                )
                .join(" · ")
            : "Waiting for a measurement";
        return `<div class="model-detail"><div class="model-detail-header"><h3>${name}</h3><strong>${m ? number(percentage, 1) + "%" : "—"}</strong></div><p>${description}</p><div class="score-track"><span style="width:${percentage}%"></span></div><div class="model-components">${components}</div></div>`;
      })
      .join("");
    const p = frame?.physics || {};
    get("physicsGrid").innerHTML = [
      ["Estimated friction (μ)", number(p.mu_est, 3)],
      [
        "Road angle",
        p.road_angle_deg == null ? "—" : number(p.road_angle_deg, 2) + "°",
      ],
      [
        "Tyre traction",
        p.a_traction_mps2 == null
          ? "—"
          : number(p.a_traction_mps2, 2) + " m/s²",
      ],
      [
        "Vehicle capability",
        p.a_capability_mps2 == null
          ? "—"
          : number(p.a_capability_mps2, 2) + " m/s²",
      ],
      [
        "Available deceleration",
        p.a_available_mps2 == null
          ? "—"
          : number(p.a_available_mps2, 2) + " m/s²",
      ],
      [
        "Observed brake component",
        p.observed_brake_component_mps2 == null
          ? "—"
          : number(p.observed_brake_component_mps2, 2) + " m/s²",
      ],
      [
        "Brake utilisation",
        p.utilisation == null ? "—" : number(p.utilisation * 100, 1) + "%",
      ],
      ["Physics classification", words(p.physics_label)],
    ]
      .map(
        ([label, value]) =>
          `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`,
      )
      .join("");
  }
  function render(s) {
    const authenticated = s.auth === "signed-in";
    visible("boot", s.auth === "loading");
    visible("authView", s.auth === "signed-out");
    visible("workspace", authenticated);
    notice(
      "authError",
      s.bootError ||
        (!s.health?.auth_configured && s.health
          ? "The server needs Supabase configuration. See the deployment guide, then retry."
          : ""),
    );
    if (!authenticated) {
      if (get("connectionDialog").open) closeDialog();
      return;
    }
    const view = titles[s.view] ? s.view : "overview",
      title = titles[view];
    text("breadcrumb", title[0]);
    text("pageTitle", title[1]);
    text("pageDescription", title[2]);
    document
      .querySelectorAll("[data-panel]")
      .forEach((panel) => (panel.hidden = panel.dataset.panel !== view));
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
      if (button.dataset.view === view)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    text("accountEmail", s.user?.email);
    text("avatar", (s.user?.email || "U")[0].toUpperCase());
    const sample = ["sample", "synthetic"].includes(s.source),
      frame = s.frame,
      t = frame?.telemetry || {},
      p = frame?.physics || {},
      decision = frame?.decision;
    get("sourceSelect").value = s.source;
    get("routeSelect").value = s.scenario;
    get("modelSelect").value = s.model;
    get("modeSelect").value = s.mode;
    get("modeSelect").disabled = s.model === "friend_gbm";
    get("harshToggle").checked = s.harsh;
    get("speedSelect").value = String(s.speed);
    get("compressGaps").checked = s.compressGaps;
    if (document.activeElement !== get("deviceId"))
      get("deviceId").value = s.deviceId;
    visible("routeField", s.source === "sample");
    visible("vehicleField", s.source === "fleet");
    visible("deviceField", ["device", "legacy"].includes(s.source));
    visible("sourceFleetRefresh", s.source === "fleet");
    visible("sourceAddConnection", s.source === "fleet");
    visible("sampleOptions", sample);
    visible("harshField", s.source === "sample");
    visible("injectButton", s.source === "sample");
    visible("stepButton", sample);
    visible("sampleDivider", s.source === "sample");
    visible("headerSample", !sample || view !== "overview");
    const vehicleOptions =
      '<option value="">' +
      (s.fleetLoading ? "Discovering vehicles…" : "Choose a vehicle") +
      "</option>" +
      s.vehicles
        .map(
          (v) =>
            `<option value="${escape(v.internal_vehicle_id)}">${escape(v.external_vehicle_id)} · ${escape(v.connection_name)}</option>`,
        )
        .join("");
    if (get("vehicleSelect").innerHTML !== vehicleOptions)
      get("vehicleSelect").innerHTML = vehicleOptions;
    get("vehicleSelect").value = s.vehicleId;
    const legacyOption = get("sourceSelect").querySelector("[value=legacy]");
    legacyOption.hidden = !s.health?.legacy_enabled;
    const disabledDemo = sample && s.health?.demo_enabled === false;
    const canStart =
      !s.busy &&
      !controller.playing &&
      !(s.source === "fleet" && !s.vehicleId) &&
      !disabledDemo;
    get("startButton").disabled = !canStart;
    get("pauseButton").disabled = !controller.playing;
    get("stepButton").disabled =
      s.busy || controller.playing || s.phase === "complete" || disabledDemo;
    get("resetButton").disabled = s.busy || (!sample && !frame);
    get("injectButton").disabled =
      s.busy || s.phase === "complete" || disabledDemo;
    text(
      "startLabel",
      s.phase === "complete"
        ? "Replay again"
        : sample
          ? "Start replay"
          : s.source === "device"
            ? "Watch device"
            : "Start monitoring",
    );
    const phase = s.busy ? "loading" : s.phase;
    text(
      "phaseBadge",
      {
        ready: disabledDemo ? "Sample disabled" : "Ready to start",
        loading: "Reading data…",
        running: sample ? "Playing" : "Monitoring",
        paused: "Paused",
        waiting: "Waiting for device",
        complete: "Replay complete",
        error: "Needs attention",
      }[phase] || "Ready",
    );
    get("phaseBadge").className = "status " + phase;
    text("sourceBadge", names[s.source]);
    const descriptions = {
      sample:
        "Recorded GPS positions with derived sample dynamics. Injected events use controlled braking values.",
      synthetic:
        "A generated drive for testing. All readings belong to this sample session.",
      fleet: s.fleetLoading
        ? "Reading your saved APIs and discovering vehicles…"
        : s.vehicles.length
          ? "Choose a vehicle, then start monitoring its latest API readings."
          : "No vehicles yet. Add an API connection and refresh, or use Run sample replay.",
      device:
        "Watch the latest complete measurement uploaded for this device ID.",
      legacy:
        "Read telemetry, GPS and context from the three APIs configured on the server.",
    };
    text("sourceDescription", descriptions[s.source]);
    let playbackMessage = s.busy
      ? "Reading the source and calculating both model results…"
      : s.phase === "complete"
        ? "You reached the end of this route. Replay again to start a new sample session."
        : controller.playing
          ? s.source === "sample"
            ? `Point ${(frame?.replay?.index ?? -1) + 1} of ${frame?.replay?.totalPoints ?? "—"} · ${s.speed}× speed${s.compressGaps ? " · gaps compressed" : ""}`
            : s.source === "device"
              ? "Waiting for the next device upload. Checking every 5 seconds."
              : "Reading your selected source automatically."
          : frame
            ? `Paused · last reading at ${time(frame.server_time)}`
            : sample
              ? "Choose a route and press Start. Sample playback does not need a live API connection."
              : "Choose a source and press Start when ready.";
    if (s.phase === "error")
      playbackMessage =
        "Playback paused. Your last readings remain visible. Retry with Start.";
    text("playbackMessage", playbackMessage);
    notice("playbackError", s.error);
    notice(
      "saveWarning",
      frame && !sample && !frame.persistence?.saved
        ? "Readings received, but history was not saved. " +
            (frame.persistence?.message || "Check the database connection.")
        : "",
      "warning",
    );
    text("speedValue", number(frame?.gps?.speed_kmh ?? t.post_event_speed_kmh));
    text("peakValue", number(t.peak_deceleration_mps2, 2));
    text("jerkValue", number(t.max_jerk_mps3, 2));
    text(
      "utilValue",
      p.utilisation == null ? "—" : number(p.utilisation * 100, 0),
    );
    text("distanceValue", number(frame?.trip?.distance_km, 2));
    text(
      "eventValue",
      frame
        ? sample
          ? s.events.length
          : (frame.trip?.harsh_events ?? s.events.length)
        : "—",
    );
    text(
      "peakCaption",
      t.telemetry_source === "derived_from_gps_speed"
        ? "Estimated from GPS speed"
        : "Current braking estimate",
    );
    text(
      "pointCount",
      s.route.length
        ? `${s.route.length} route point${s.route.length === 1 ? "" : "s"}`
        : "No route yet",
    );
    text(
      "coordinates",
      `GPS ${number(frame?.gps?.lat, 5)}, ${number(frame?.gps?.lon, 5)}`,
    );
    const probability = decision?.probability_harsh,
      harsh = decision?.harsh_or_severe;
    text(
      "riskValue",
      probability == null ? "—" : number(probability * 100, 1) + "%",
    );
    get("riskRing").style.setProperty(
      "--risk",
      Math.max(0, Math.min(100, Number(probability || 0) * 100)) + "%",
    );
    get("riskRing").style.setProperty(
      "--risk-color",
      harsh ? "var(--danger)" : "var(--accent)",
    );
    text(
      "decisionPill",
      decision ? (harsh ? "Harsh / severe" : "Normal / mild") : "Waiting",
    );
    get("decisionPill").className =
      "pill " + (decision ? (harsh ? "danger" : "") : "neutral");
    text(
      "decisionTitle",
      decision
        ? harsh
          ? "Harsh braking detected"
          : "Normal / mild braking"
        : "Ready for your first reading",
    );
    text(
      "decisionText",
      decision
        ? `${s.model === "new_ai" ? "CALIBR8-AI" : "Friend GBM"} classified this measurement as ${words(decision.prediction)}. See Models & physics for the comparison.`
        : "Start a source to calculate the braking decision.",
    );
    text(
      "aiValue",
      frame
        ? number(frame.models.new_ai.probability_harsh * 100, 1) + "%"
        : "—",
    );
    text(
      "friendValue",
      frame
        ? number(frame.models.friend_gbm.probability_harsh * 100, 1) + "%"
        : "—",
    );
    text("physicsValue", words(p.physics_label));
    if (lastRoute !== s.route) {
      map.update(s.route);
      lastRoute = s.route;
    }
    if (lastChart !== s.chart) {
      renderChart(get("telemetryPlot"), s.chart);
      lastChart = s.chart;
    }
    text(
      "updatedTime",
      frame ? "Updated " + time(frame.server_time) : "Waiting for data",
    );
    const c = frame?.context || {};
    get("contextGrid").innerHTML = [
      ["Vehicle", words(c.vehicle_type)],
      ["Road", words(c.road_type)],
      ["Traffic", words(c.traffic_density)],
      ["Weather", words(c.weather)],
      ["Surface", words(c.road_surface)],
      [
        "Grade",
        c.road_grade_ratio == null
          ? "—"
          : number(c.road_grade_ratio * 100, 1) + "%",
      ],
    ]
      .map(
        ([label, value]) =>
          `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`,
      )
      .join("");
    text(
      "qualityNote",
      frame?.quality?.note ||
        "Measurement quality appears when data is available.",
    );
    text(
      "footerSource",
      sample
        ? "Sample session · export events before starting again"
        : frame?.fleet_api?.stale
          ? "Source has not supplied a newer point"
          : names[s.source],
    );
    renderConnections(s);
    renderFleet(s);
    renderEvents(s);
    renderModels(frame);
    const raw = frame
      ? get("payloadSelect").value === "frame"
        ? frame
        : frame.raw_api_output
      : null;
    text(
      "apiOutput",
      raw
        ? JSON.stringify(raw, null, 2)
        : "No response yet. Press Start to read your selected source.",
    );
    get("copyOutput").disabled = !frame;
    text(
      "payloadDescription",
      frame
        ? `${names[s.source]} · received at ${time(frame.server_time)}${frame.fleet_api?.stale ? " · unchanged source point" : ""}`
        : "Run a source to inspect its most recent response.",
    );
    text("payloadBadge", frame ? "Response received" : "Waiting");
    text(
      "sampleEndpoint",
      location.origin + "/api/mock/live?scenario=" + s.scenario,
    );
  }

  store.subscribe(render);
  applyTheme();
  get("authTheme").value = get("themeSelect").value;
  render(store.get());
  get("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    get("loginButton").disabled = true;
    get("loginForm").setAttribute("aria-busy", "true");
    text("loginButton", "Signing in…");
    store.set({ bootError: "" });
    try {
      await controller.login(get("email").value.trim(), get("password").value);
      get("password").value = "";
    } catch (error) {
      store.set({ bootError: error.message });
    } finally {
      get("loginButton").disabled = false;
      get("loginForm").setAttribute("aria-busy", "false");
      text("loginButton", "Sign in →");
    }
  });
  get("showPassword").addEventListener("click", () => {
    const show = get("password").type === "password";
    get("password").type = show ? "text" : "password";
    text("showPassword", show ? "Hide" : "Show");
    get("showPassword").setAttribute("aria-pressed", String(show));
    get("showPassword").setAttribute(
      "aria-label",
      show ? "Hide password" : "Show password",
    );
  });
  get("logoutButton").addEventListener(
    "click",
    safe(async () => {
      get("logoutButton").disabled = true;
      try {
        await controller.logout();
      } finally {
        get("logoutButton").disabled = false;
      }
    }),
  );
  get("bootRetry").addEventListener("click", () => location.reload());
  get("sourceSelect").addEventListener(
    "change",
    safe((event) => controller.setSource(event.target.value)),
  );
  get("routeSelect").addEventListener("change", (event) =>
    controller.setScenario(event.target.value),
  );
  get("harshToggle").addEventListener("change", (event) =>
    controller.setHarsh(event.target.checked),
  );
  get("deviceId").addEventListener("change", (event) =>
    controller.setDevice(event.target.value),
  );
  get("vehicleSelect").addEventListener(
    "change",
    safe((event) => controller.selectVehicle(event.target.value)),
  );
  get("modelSelect").addEventListener(
    "change",
    safe((event) => controller.selectModel(event.target.value)),
  );
  get("modeSelect").addEventListener(
    "change",
    safe((event) =>
      controller.selectModel(store.get().model, event.target.value),
    ),
  );
  get("speedSelect").addEventListener("change", (event) =>
    store.set({ speed: Number(event.target.value) }),
  );
  get("compressGaps").addEventListener("change", (event) =>
    store.set({ compressGaps: event.target.checked }),
  );
  get("startButton").addEventListener(
    "click",
    safe(() => controller.start()),
  );
  get("pauseButton").addEventListener("click", () => controller.pause());
  get("stepButton").addEventListener(
    "click",
    safe(() => controller.step()),
  );
  get("injectButton").addEventListener(
    "click",
    safe(() => controller.step(true)),
  );
  get("resetButton").addEventListener(
    "click",
    safe(() => controller.reset()),
  );
  get("headerSample").addEventListener(
    "click",
    safe(() => controller.runSample()),
  );
  get("viewOutput").addEventListener("click", () => {
    controller.setView("data");
    get("main").focus();
  });
  get("sourceFleetRefresh").addEventListener(
    "click",
    safe(() => controller.discover()),
  );
  get("discoverButton").addEventListener(
    "click",
    safe(() => controller.discover()),
  );
  get("fleetSearch").addEventListener("input", () => renderFleet(store.get()));
  get("eventSearch").addEventListener("input", () => renderEvents(store.get()));
  get("payloadSelect").addEventListener("change", () => render(store.get()));
  get("mapZoomIn").addEventListener("click", () => map.changeZoom(1));
  get("mapZoomOut").addEventListener("click", () => map.changeZoom(-1));
  get("mapFit").addEventListener("click", () => map.fit());
  get("menuButton").addEventListener("click", () => {
    const open = !get("sidebar").classList.contains("open");
    get("sidebar").classList.toggle("open", open);
    get("sidebarScrim").hidden = !open;
    get("menuButton").setAttribute("aria-expanded", String(open));
    if (open) get("sidebar").querySelector("button").focus();
  });
  get("sidebarScrim").addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (get("connectionDialog").open) closeDialog();
      closeMenu();
    }
  });
  for (const id of ["themeSelect", "authTheme"])
    get(id).addEventListener("change", (event) => {
      applyTheme(event.target.value);
      get("authTheme").value = event.target.value;
    });
  document.addEventListener(
    "click",
    safe(async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.view) {
        controller.setView(button.dataset.view);
        closeMenu();
        if (button.dataset.view === "overview") map.draw();
      }
      if (button.dataset.theme) {
        applyTheme(button.dataset.theme);
        get("authTheme").value = button.dataset.theme;
      }
      if (button.dataset.action === "add-connection") openConnection();
      if (button.dataset.action === "run-sample") await controller.runSample();
      if (button.dataset.edit)
        openConnection(
          store
            .get()
            .connections.find((c) => c.connection_id === button.dataset.edit),
        );
      if (button.dataset.test) {
        button.disabled = true;
        try {
          const result = await api.post(
            "/api/connections/" +
              encodeURIComponent(button.dataset.test) +
              "/test",
          );
          toast(
            result.status?.ok
              ? result.vehicles.length
                ? `Connected · ${result.vehicles.length} vehicle(s) found.`
                : "Connected, but no vehicles matched. Check the field mapping."
              : result.status?.message || "Connection failed.",
          );
        } finally {
          button.disabled = false;
        }
      }
      if (button.dataset.remove) {
        const connection = store
          .get()
          .connections.find((c) => c.connection_id === button.dataset.remove);
        if (
          window.confirm(
            `Remove ${connection?.name || "this connection"}? Existing trip history will be kept.`,
          )
        ) {
          await api.delete(
            "/api/connections/" + encodeURIComponent(button.dataset.remove),
          );
          await controller.loadConnections();
          toast("Connection removed.");
        }
      }
      if (button.dataset.monitor) {
        await controller.setSource("fleet");
        await controller.selectVehicle(button.dataset.monitor);
        controller.setView("overview");
        await controller.start();
      }
    }),
  );
  get("closeDialog").addEventListener("click", closeDialog);
  get("cancelDialog").addEventListener("click", closeDialog);
  get("connectionDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  get("connectionDialog").addEventListener("click", (event) => {
    if (event.target === get("connectionDialog")) {
      const rect = event.target.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        closeDialog();
    }
  });
  get("connectionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const auth = controller.authEpoch;
    get("saveConnectionButton").disabled = true;
    notice("connectionMessage", "Saving connection…", "");
    try {
      let headers = null;
      const raw = get("connectionHeaders").value.trim();
      if (raw) {
        try {
          headers = JSON.parse(raw);
        } catch {
          throw new Error("Request headers must be valid JSON.");
        }
        if (
          !headers ||
          Array.isArray(headers) ||
          typeof headers !== "object" ||
          Object.values(headers).some((v) => typeof v !== "string")
        )
          throw new Error(
            "Headers must be a JSON object containing string values.",
          );
      }
      const payload = {
        connection_id: get("connectionId").value || null,
        name: get("connectionName").value.trim(),
        url: get("connectionUrl").value.trim(),
        enabled: get("connectionEnabled").checked,
        headers,
        root_path: get("rootPath").value.trim() || null,
        poll_interval_sec: Number(get("pollInterval").value),
        speed_unit: get("speedUnit").value,
        timestamp_format: get("timestampFormat").value,
        field_mapping: {
          device_id: get("mapDevice").value.trim(),
          timestamp: get("mapTimestamp").value.trim(),
          latitude: get("mapLat").value.trim(),
          longitude: get("mapLon").value.trim(),
          speed: get("mapSpeed").value.trim(),
          direction: get("mapDirection").value.trim(),
        },
        default_context: {
          vehicle_type: get("ctxVehicle").value,
          road_type: get("ctxRoad").value,
          traffic_density: get("ctxTraffic").value,
          weather: get("ctxWeather").value,
          road_surface: get("ctxSurface").value,
          road_grade_ratio: Number(get("ctxGrade").value) / 100,
        },
      };
      await api.post("/api/connections", payload);
      if (auth !== controller.authEpoch) return;
      await controller.loadConnections();
      closeDialog();
      toast("Connection saved. Refresh the fleet to discover its vehicles.");
    } catch (error) {
      if (auth === controller.authEpoch)
        notice("connectionMessage", error.message);
    } finally {
      get("saveConnectionButton").disabled = false;
    }
  });
  get("exportButton").addEventListener("click", () => {
    const s = store.get();
    const blob = new Blob([csv(s.events)], { type: "text/csv;charset=utf-8" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `calibr8_${s.source}_events.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  async function copy(value, label) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      toast(label + " copied.");
    } else
      toast("Copy is unavailable here. Select the displayed text and copy it.");
  }
  get("copyOutput").addEventListener(
    "click",
    safe(() => copy(get("apiOutput").textContent, "JSON")),
  );
  get("copyEndpoint").addEventListener(
    "click",
    safe(() => copy(get("sampleEndpoint").textContent, "Sample endpoint")),
  );
  get("diagnosticsButton").addEventListener("click", async () => {
    get("diagnosticsButton").disabled = true;
    notice("diagnosticsResult", "Checking your workspace…", "");
    try {
      const result = await api.get("/api/diagnostics");
      notice(
        "diagnosticsResult",
        result.message,
        result.ok ? "success" : "warning",
      );
    } catch (error) {
      notice("diagnosticsResult", error.message);
    } finally {
      get("diagnosticsButton").disabled = false;
    }
  });
  window.CALIBR8_READY = true;
  const ready = controller.boot();
  return {
    store,
    controller,
    api,
    ready,
    render,
    close() {
      controller.stop();
      map.destroy();
      clearTimeout(toastTimer);
    },
  };
}
export const app = createApp();
