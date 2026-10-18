/* Load the real local ES modules into a DOM, with no CDN libraries available. */
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.resolve(__dirname, ".."),
  fixtures = JSON.parse(
    fs.readFileSync(
      process.env.CALIBR8_TEST_FIXTURES ||
        path.join(__dirname, "fixtures.json"),
      "utf8",
    ),
  );
const copy = (value) => JSON.parse(JSON.stringify(value)),
  pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check, label) {
  for (let i = 0; i < 180; i++) {
    if (check()) return;
    await pause();
  }
  assert.ok(check(), label);
}
const reply = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => copy(data),
});
async function setup(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "public/index.html"), "utf8"),
    {
      url: "https://dashboard.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const w = dom.window,
    requests = [],
    savedConnections = options.connections || [];
  let loggedIn = Boolean(options.saved),
    expired = false,
    failNext = false,
    sequence = 0;
  w.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  w.AbortController = AbortController;
  w.DOMException = DOMException;
  w.confirm = () => true;
  w.URL.createObjectURL = () => "blob:test";
  w.URL.revokeObjectURL = () => {};
  let copied = "";
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        copied = value;
      },
    },
  });
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url, w.location.href),
      p = u.pathname,
      b = opts.body ? JSON.parse(opts.body) : {};
    requests.push({
      path: p,
      body: b,
      method: opts.method || "GET",
      signal: opts.signal,
    });
    if (options.handler) {
      const result = await options.handler(p, b, opts);
      if (result !== undefined) return result;
    }
    if (p === "/api/health")
      return reply({
        ok: true,
        auth_configured: true,
        demo_enabled: true,
        legacy_enabled: false,
        version: "7.0.0",
      });
    if (p === "/api/auth/login") {
      if (b.password !== "test-password")
        return reply({ detail: "Invalid login credentials" }, 401);
      loggedIn = true;
      return reply({ user: { id: "member", email: "member@example.com" } });
    }
    if (p === "/api/auth/logout") {
      loggedIn = false;
      return reply({ ok: true });
    }
    if (p === "/api/auth/refresh") {
      if (!loggedIn) return reply({ detail: "Sign in again" }, 401);
      expired = false;
      return reply({ user: { id: "member", email: "member@example.com" } });
    }
    if (!loggedIn || expired) return reply({ detail: "Session expired" }, 401);
    if (p === "/api/auth/session")
      return reply({ user: { id: "member", email: "member@example.com" } });
    if (p === "/api/connections" && opts.method === "POST") {
      const connection = {
        ...b,
        has_headers: Boolean(b.headers && Object.keys(b.headers).length),
        connection_id: b.connection_id || "conn-new",
      };
      delete connection.headers;
      savedConnections.push(connection);
      return reply({ connection });
    }
    if (p === "/api/connections" && opts.method === "DELETE")
      return reply({ ok: true });
    if (p === "/api/connections")
      return reply({ connections: savedConnections });
    if (p === "/api/fleet/discover")
      return reply({
        vehicles: options.fleet ? [fixtures.vehicle] : [],
        connections: [],
      });
    if (p === "/api/replay/step" || p === "/api/synthetic/step") {
      if (failNext) {
        failNext = false;
        return reply({ detail: "Replay request failed" }, 502);
      }
      const frame = copy(b.inject ? fixtures.harsh : fixtures.normal);
      frame.frame_id = b.run_id + ":" + b.index;
      frame.route_point.id = frame.route_point.frame_id = frame.frame_id;
      if (frame.event)
        frame.event.event_id = frame.event.frame_id = frame.frame_id;
      frame.run_id = b.run_id;
      frame.source = p.includes("synthetic") ? "synthetic" : "sample";
      frame.trip.active_trip_id = b.run_id;
      frame.replay.index = b.index;
      frame.replay.totalPoints = options.total || 200;
      frame.complete = b.index >= frame.replay.totalPoints - 1;
      frame.selected_model = b.model;
      frame.mode = b.mode;
      frame.decision = frame.models[b.model];
      frame.server_time = new Date(Date.now() + ++sequence * 100).toISOString();
      return reply(frame);
    }
    if (p === "/api/evaluate") {
      const result = copy(fixtures.harsh);
      result.selected_model = b.model;
      result.mode = b.mode;
      result.decision = result.models[b.model];
      return reply(
        Object.fromEntries(
          [
            "telemetry",
            "gps",
            "context",
            "models",
            "decision",
            "physics",
            "selected_model",
            "mode",
          ].map((key) => [key, result[key]]),
        ),
      );
    }
    if (p === "/api/monitor/tick") return reply(fixtures.fleet);
    if (p === "/api/state")
      return reply(
        options.state || { frame: null, history: { route: [], events: [] } },
      );
    if (p === "/api/diagnostics")
      return reply({
        ok: true,
        message: "Authentication and database access are working.",
      });
    if (p.endsWith("/test"))
      return reply({ status: { ok: true }, vehicles: [fixtures.vehicle] });
    if (p === "/api/vehicle/reset")
      return reply({ active_trip_id: "new-trip" });
    throw new Error("Unhandled request " + p);
  };
  const context = dom.getInternalVMContext(),
    modules = new Map();
  async function load(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename);
    const mod = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
      context,
      identifier: filename,
    });
    modules.set(filename, mod);
    await mod.link((specifier, ref) =>
      load(path.resolve(path.dirname(ref.identifier), specifier)),
    );
    return mod;
  }
  const module = await load(path.join(root, "public/js/app.js"));
  await module.evaluate();
  const app = module.namespace.app;
  const get = (id) => w.document.getElementById(id);
  const click = (id) => get(id).click();
  const change = (id, value) => {
    get(id).value = value;
    get(id).dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const login = async (password = "test-password") => {
    get("email").value = "member@example.com";
    get("password").value = password;
    get("loginForm").dispatchEvent(
      new w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await pause();
  };
  return {
    w,
    app,
    get,
    click,
    change,
    login,
    requests,
    errors,
    expired() {
      expired = true;
    },
    fail() {
      failNext = true;
    },
    get copied() {
      return copied;
    },
    close() {
      app.close();
      dom.window.close();
    },
  };
}

async function run() {
  let t = await setup();
  try {
    await t.app.ready;
    assert.equal(t.app.store.get().auth, "signed-out");
    assert.equal(t.get("authView").hidden, false);
    assert.equal(t.get("workspace").hidden, true);
    await t.login("wrong");
    await until(() => !t.get("authError").hidden, "Invalid login is visible");
    assert.ok(t.get("authError").textContent.includes("Invalid login"));
    assert.equal(t.get("loginButton").disabled, false);
    await t.login();
    await until(
      () => !t.get("workspace").hidden,
      "Successful response opens workspace",
    );
    assert.equal(t.get("authView").hidden, true);
    assert.equal(t.get("password").value, "");
    assert.equal(t.get("sourceSelect").value, "sample");
    assert.equal(t.get("routeField").hidden, false);
    assert.equal(t.get("vehicleField").hidden, true);
    assert.equal(t.get("startButton").disabled, false);
    assert.equal(
      t.requests.filter((r) => r.path === "/api/fleet/discover").length,
      0,
      "Sample startup must not wait for fleet discovery",
    );
    t.click("startButton");
    await until(() => t.app.store.get().frame, "Start reads the sample");
    t.click("pauseButton");
    assert.equal(
      t.get("speedValue").textContent,
      fixtures.normal.gps.speed_kmh.toFixed(1),
    );
    assert.equal(
      t.get("peakValue").textContent,
      fixtures.normal.telemetry.peak_deceleration_mps2.toFixed(2),
    );
    assert.notEqual(t.get("utilValue").textContent, "—");
    assert.ok(t.get("routeMap").querySelector(".route-line").getAttribute("d"));
    assert.ok(t.get("telemetryPlot").querySelector("svg"));
    assert.equal(t.app.store.get().phase, "paused");
    console.log(
      "PASS fresh login, invalid password, stable sample startup, and measurement/map/chart updates without CDN libraries",
    );
    t.click("injectButton");
    await until(
      () => t.get("decisionPill").textContent === "Harsh / severe",
      "Injection is visible",
    );
    assert.equal(t.get("peakValue").textContent, "-6.50");
    assert.equal(t.get("jerkValue").textContent, "-13.00");
    assert.equal(t.get("eventValue").textContent, "1");
    t.click("viewOutput");
    assert.equal(t.get("apiOutput").textContent.includes("deviceId"), true);
    assert.equal(t.app.store.get().view, "data");
    t.click("copyOutput");
    await pause();
    assert.equal(t.copied, t.get("apiOutput").textContent);
    t.change("payloadSelect", "frame");
    assert.ok(t.get("apiOutput").textContent.includes("schema_version"));
    t.change("modelSelect", "friend_gbm");
    await until(() => !t.app.store.get().busy, "Model evaluation finishes");
    assert.equal(t.get("modeSelect").disabled, true);
    assert.ok(t.get("decisionText").textContent.includes("Friend GBM"));
    console.log(
      "PASS harsh injection, event count, raw/complete API output, copy and paused model comparison",
    );
    t.fail();
    await t.app.controller.step();
    assert.equal(t.get("playbackError").hidden, false);
    assert.equal(t.get("startButton").disabled, false);
    const lastSpeed = t.get("speedValue").textContent;
    assert.notEqual(lastSpeed, "—");
    t.click("startButton");
    await until(
      () => t.get("playbackError").hidden && t.app.controller.playing,
      "Retry recovers playback",
    );
    t.click("pauseButton");
    t.change("themeSelect", "light");
    assert.equal(t.w.document.documentElement.dataset.theme, "light");
    assert.equal(t.w.localStorage.getItem("calibr8-theme"), "light");
    t.change("themeSelect", "dark");
    assert.equal(t.w.document.documentElement.dataset.theme, "dark");
    t.change("themeSelect", "system");
    assert.equal(t.w.document.documentElement.dataset.theme, "dark");
    t.click("menuButton");
    assert.equal(t.get("menuButton").getAttribute("aria-expanded"), "true");
    t.w.document.dispatchEvent(
      new t.w.KeyboardEvent("keydown", { key: "Escape" }),
    );
    assert.equal(t.get("menuButton").getAttribute("aria-expanded"), "false");
    console.log(
      "PASS failed request retains readings, retry, light/dark/system themes and mobile navigation",
    );
    t.w.document.querySelector("[data-view=fleet]").click();
    await until(
      () => !t.app.store.get().connectionsLoading,
      "Connections load",
    );
    t.w.document
      .querySelector("#fleetPanel [data-action=add-connection]")
      .click();
    assert.equal(t.get("connectionDialog").open, true);
    t.get("connectionName").value = "Customer API";
    t.get("connectionUrl").value = "https://api.example.com/vehicles";
    t.get("connectionHeaders").value = "{bad";
    t.get("connectionForm").dispatchEvent(
      new t.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(
      () => t.get("connectionMessage").textContent.includes("valid JSON"),
      "Invalid headers are explained",
    );
    t.get("connectionHeaders").value = '{"Authorization":"Bearer local-test"}';
    t.get("mapDevice").value = "vehicle.id";
    t.get("ctxWeather").value = "light_rain";
    t.get("ctxSurface").value = "wet_asphalt";
    t.get("connectionForm").dispatchEvent(
      new t.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(
      () => !t.get("connectionDialog").open,
      "Valid API connection saves",
    );
    const saved = t.requests.find(
      (r) => r.path === "/api/connections" && r.method === "POST",
    );
    assert.equal(saved.body.field_mapping.device_id, "vehicle.id");
    assert.equal(saved.body.default_context.weather, "light_rain");
    assert.ok(t.get("connectionList").textContent.includes("Customer API"));
    t.w.document.querySelector("[data-view=settings]").click();
    t.click("diagnosticsButton");
    await until(
      () => t.get("diagnosticsResult").classList.contains("success"),
      "Database diagnostic result",
    );
    console.log(
      "PASS API form validation, encrypted-header payload, nested mapping, context and workspace diagnostics",
    );
    const refreshes = t.requests.filter(
      (r) => r.path === "/api/auth/refresh",
    ).length;
    t.expired();
    await Promise.all([
      t.app.api.get("/api/connections"),
      t.app.api.post("/api/fleet/discover"),
    ]);
    assert.equal(
      t.requests.filter((r) => r.path === "/api/auth/refresh").length,
      refreshes + 1,
      "Concurrent failures share one refresh",
    );
    assert.equal(t.app.store.get().auth, "signed-in");
    t.click("logoutButton");
    await until(
      () => t.app.store.get().auth === "signed-out",
      "Sign-out closes workspace",
    );
    await t.login();
    await until(
      () => t.app.store.get().auth === "signed-in",
      "Sign-in after sign-out",
    );
    assert.deepEqual(t.errors, []);
    console.log("PASS single-flight token refresh, logout, and login again");
  } finally {
    t.close();
  }

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let delayed = true;
  t = await setup({
    saved: true,
    handler: async (p, b) => {
      if (p === "/api/replay/step" && delayed) {
        delayed = false;
        await gate;
        const frame = copy(fixtures.normal);
        frame.frame_id = "late-frame";
        return reply(frame);
      }
    },
  });
  try {
    await t.app.ready;
    t.click("startButton");
    await until(() => t.app.store.get().busy, "Replay request in flight");
    t.change("sourceSelect", "fleet");
    await until(
      () => !t.app.store.get().fleetLoading,
      "Empty fleet is discovered",
    );
    release();
    await pause();
    await pause();
    assert.equal(t.app.store.get().source, "fleet");
    assert.equal(t.app.store.get().frame, null);
    assert.equal(t.get("routeField").hidden, true);
    assert.equal(t.get("vehicleField").hidden, false);
    assert.equal(t.get("startButton").disabled, true);
    assert.ok(t.get("sourceDescription").textContent.includes("No vehicles"));
    t.click("headerSample");
    await until(
      () => t.app.store.get().frame,
      "Direct sample starts with no live vehicles",
    );
    t.click("pauseButton");
    assert.equal(t.app.store.get().source, "sample");
    assert.deepEqual(t.errors, []);
    console.log(
      "PASS switching source during an in-flight request ignores late data; empty fleet can run the sample",
    );
  } finally {
    release();
    t.close();
  }

  t = await setup({
    saved: true,
    total: 2,
    fleet: true,
    connections: [fixtures.connection],
  });
  try {
    await t.app.ready;
    await t.app.controller.step();
    await t.app.controller.step();
    assert.equal(t.app.store.get().phase, "complete");
    assert.equal(t.get("startLabel").textContent, "Replay again");
    const old = t.app.store.get().runId;
    t.click("startButton");
    await until(
      () => t.app.store.get().runId !== old && t.app.store.get().frame,
      "Replay again creates a fresh run",
    );
    t.click("pauseButton");
    assert.equal(t.app.store.get().route.length, 1);
    t.change("sourceSelect", "fleet");
    await until(
      () => t.app.store.get().vehicleId,
      "Discovered vehicle selected",
    );
    t.click("startButton");
    await until(
      () => t.get("speedValue").textContent === "32.0",
      "Live monitoring readings",
    );
    t.click("pauseButton");
    assert.equal(t.get("peakValue").textContent, "-2.88");
    console.log(
      "PASS route completion, clean restart and live GPS-derived measurements",
    );
    assert.deepEqual(t.errors, []);
  } finally {
    t.close();
  }

  let finishConnections;
  const connectionGate = new Promise(
    (resolve) => (finishConnections = resolve),
  );
  t = await setup({
    saved: true,
    handler: async (p) => {
      if (p === "/api/connections") {
        await connectionGate;
        return reply({ connections: [fixtures.connection] });
      }
    },
  });
  try {
    await t.app.ready;
    t.w.document.querySelector("[data-view=fleet]").click();
    await pause();
    t.click("logoutButton");
    await until(
      () => t.app.store.get().auth === "signed-out",
      "Logout during connection loading",
    );
    finishConnections();
    await pause();
    await pause();
    assert.equal(t.app.store.get().connections.length, 0);
    assert.equal(t.get("workspace").hidden, true);
    assert.deepEqual(t.errors, []);
    console.log(
      "PASS late connection responses after logout cannot restore private workspace data",
    );
  } finally {
    finishConnections();
    t.close();
  }
  let releaseHealth;
  const healthGate = new Promise((resolve) => (releaseHealth = resolve));
  t = await setup({
    saved: true,
    handler: async (p) => {
      if (p === "/api/health") {
        await healthGate;
        return reply({ ok: true, auth_configured: true, demo_enabled: true });
      }
    },
  });
  try {
    await until(
      () => !t.get("workspace").hidden,
      "Session opens before delayed health request",
    );
    assert.equal(t.get("sourceSelect").value, "sample");
    assert.equal(t.get("routeField").hidden, false);
    releaseHealth();
    await t.app.ready;
    assert.equal(t.get("routeField").hidden, false);
    console.log(
      "PASS delayed startup status cannot hide replay controls or block a saved session",
    );
  } finally {
    releaseHealth();
    t.close();
  }

  t = await setup({
    saved: true,
    fleet: true,
    handler: async (p) => {
      if (p === "/api/monitor/tick")
        return reply({
          ...fixtures.fleet,
          persistence: { saved: false, message: "Database save failed" },
        });
    },
  });
  try {
    await t.app.ready;
    await t.app.controller.setSource("fleet");
    await t.app.controller.step();
    assert.equal(t.get("speedValue").textContent, "32.0");
    assert.equal(t.get("saveWarning").hidden, false);
    assert.ok(
      t.get("saveWarning").textContent.includes("Database save failed"),
    );
    assert.equal(t.get("playbackError").hidden, true);
    console.log(
      "PASS history-save failures remain separate from successful live readings",
    );
  } finally {
    t.close();
  }

  const device = copy(fixtures.fleet);
  device.source = "device";
  device.vehicle_id = "device_vehicle";
  t = await setup({
    saved: true,
    state: { frame: device, history: { route: [], events: [] } },
  });
  try {
    await t.app.ready;
    await t.app.controller.setSource("device");
    await t.app.controller.selectModel("friend_gbm", "safety");
    await t.app.controller.step();
    assert.equal(t.app.store.get().frame.selected_model, "friend_gbm");
    assert.ok(t.get("decisionText").textContent.includes("Friend GBM"));
    assert.ok(t.requests.some((r) => r.path === "/api/evaluate"));
    console.log("PASS device polling respects the dashboard model selection");
  } finally {
    t.close();
  }
  let stallBody = true;
  t = await setup({
    saved: true,
    handler: async (p, b, opts) => {
      if (p === "/api/replay/step" && stallBody)
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve, reject) =>
              opts.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              ),
            ),
        };
    },
  });
  try {
    await t.app.ready;
    t.app.api.timeoutMs = 20;
    t.click("startButton");
    await until(
      () => t.get("playbackError").textContent.includes("took too long"),
      "A stalled response body times out",
    );
    assert.equal(t.get("startButton").disabled, false);
    stallBody = false;
    t.app.api.timeoutMs = 25000;
    t.click("startButton");
    await until(() => t.app.store.get().frame, "Retry after stalled response");
    t.click("pauseButton");
    console.log("PASS stalled response bodies time out and playback can retry");
  } finally {
    t.close();
  }

  let saveAttempt = 0;
  t = await setup({
    saved: true,
    fleet: true,
    handler: async (p) => {
      if (p !== "/api/monitor/tick") return;
      const frame = copy(fixtures.harsh);
      frame.source = "fleet";
      frame.vehicle_id = fixtures.vehicle.internal_vehicle_id;
      frame.trip.harsh_events = 1;
      frame.persistence = { saved: ++saveAttempt > 1, message: "Pending save" };
      if (frame.persistence.saved) {
        frame.route_point.id = "trip:" + frame.route_point.id;
        frame.event.event_id = "trip:" + frame.event.event_id;
      }
      return reply(frame);
    },
  });
  try {
    await t.app.ready;
    await t.app.controller.setSource("fleet");
    await t.app.controller.step();
    await t.app.controller.step();
    assert.equal(t.app.store.get().route.length, 1);
    assert.equal(t.app.store.get().events.length, 1);
    assert.equal(t.get("saveWarning").hidden, true);
    console.log(
      "PASS successful save retries do not duplicate the previously displayed point or event",
    );
  } finally {
    t.close();
  }
  let finishOldRequest;
  const oldRequest = new Promise((resolve) => (finishOldRequest = resolve));
  t = await setup({
    saved: true,
    handler: async (p) => {
      if (p === "/api/connections") {
        await oldRequest;
        return reply({ detail: "Old session expired" }, 401);
      }
    },
  });
  try {
    await t.app.ready;
    const pending = t.app.api.get("/api/connections").catch((error) => error);
    await t.app.controller.logout();
    await t.login();
    await until(
      () => t.app.store.get().auth === "signed-in",
      "New login completes",
    );
    const refreshes = t.requests.filter(
      (r) => r.path === "/api/auth/refresh",
    ).length;
    finishOldRequest();
    await pending;
    assert.equal(t.app.store.get().auth, "signed-in");
    assert.equal(
      t.requests.filter((r) => r.path === "/api/auth/refresh").length,
      refreshes,
    );
    console.log(
      "PASS an old unauthorized response cannot sign out a newer session",
    );
  } finally {
    finishOldRequest();
    t.close();
  }
  console.log("All frontend integration checks passed.");
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
