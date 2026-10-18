import { blankData, acceptFrame } from "./store.js";

const sampleSource = (source) => ["sample", "synthetic"].includes(source);

export class Controller {
  constructor(api, store) {
    this.api = api;
    this.store = store;
    this.epoch = 0;
    this.authEpoch = 0;
    this.timer = null;
    this.abort = null;
    this.playing = false;
    this.connectionRequest = 0;
    this.fleetRequest = 0;
    api.onUnauthorized = () =>
      this.signedOut("Your session ended. Please sign in again.");
  }
  async boot() {
    const authEpoch = ++this.authEpoch;
    this.store.set({ auth: "loading", bootError: "" });
    const health = this.api
      .get("/api/health")
      .then((value) => this.store.set({ health: value }))
      .catch((error) => this.store.set({ bootError: error.message }));
    const restore = this.api
      .get("/api/auth/session")
      .then((data) => {
        if (authEpoch === this.authEpoch) this.signedIn(data.user);
      })
      .catch((error) => {
        if (authEpoch !== this.authEpoch) return;
        this.store.set({
          auth: "signed-out",
          bootError: error.status === 401 ? "" : error.message,
        });
      });
    await Promise.allSettled([health, restore]);
  }
  signedIn(user) {
    this.api.sessionChanged();
    this.stop();
    this.store.set({
      user,
      auth: "signed-in",
      bootError: "",
      source: "sample",
      ...blankData(),
    });
  }
  signedOut(message = "") {
    this.api.sessionChanged();
    ++this.authEpoch;
    this.stop();
    this.store.set({
      auth: "signed-out",
      user: null,
      bootError: message,
      connections: [],
      vehicles: [],
      connectionResults: [],
      connectionError: "",
      fleetError: "",
      connectionsLoading: false,
      fleetLoading: false,
      ...blankData(),
    });
  }
  async login(email, password) {
    const revision = ++this.authEpoch;
    const result = await this.api.post("/api/auth/login", { email, password });
    if (revision === this.authEpoch) this.signedIn(result.user);
  }
  async logout() {
    ++this.authEpoch;
    this.stop();
    try {
      await this.api.post("/api/auth/logout");
    } finally {
      this.signedOut();
    }
  }
  stop() {
    this.playing = false;
    ++this.epoch;
    clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }
  pause() {
    this.stop();
    this.store.set({
      busy: false,
      phase: this.store.get().frame ? "paused" : "ready",
    });
  }
  setView(view) {
    this.store.set({ view });
    if (view === "fleet" && !this.store.get().connections.length)
      this.loadConnections();
  }
  async setSource(source) {
    if (!["sample", "synthetic", "fleet", "device", "legacy"].includes(source))
      return;
    this.stop();
    this.store.set({ source, vehicleId: "", ...blankData() });
    if (source === "fleet") await this.discover();
  }
  resetSample(patch = {}) {
    this.stop();
    this.store.set({ ...blankData(), ...patch });
  }
  setScenario(scenario) {
    this.resetSample({ scenario });
  }
  setHarsh(harsh) {
    this.resetSample({ harsh });
  }
  setDevice(deviceId) {
    this.resetSample({ deviceId: deviceId.trim() });
  }
  async reset() {
    const s = this.store.get();
    if (sampleSource(s.source)) return this.resetSample();
    this.stop();
    const epoch = this.epoch;
    const vehicle = s.source === "fleet" ? s.vehicleId : s.deviceId;
    if (!vehicle) return;
    this.store.set({ busy: true, error: "" });
    try {
      await this.api.post("/api/vehicle/reset", { vehicle_id: vehicle });
      if (epoch === this.epoch) this.store.set(blankData());
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    } finally {
      if (epoch === this.epoch) this.store.set({ busy: false });
    }
  }
  async runSample() {
    await this.setSource("sample");
    this.store.set({ view: "overview" });
    return this.start();
  }
  async start() {
    if (this.store.get().busy || this.playing) return;
    if (this.store.get().phase === "complete") this.resetSample();
    this.playing = true;
    const epoch = ++this.epoch;
    this.store.set({ error: "", phase: "running" });
    await this.tick(epoch);
  }
  async step(inject = false) {
    if (this.store.get().busy) return;
    this.stop();
    const epoch = this.epoch;
    await this.tick(epoch, { inject });
  }
  fail(error) {
    this.playing = false;
    clearTimeout(this.timer);
    this.store.set({ phase: "error", error: error.message, busy: false });
  }
  async tick(epoch, { inject = false } = {}) {
    if (epoch !== this.epoch || this.store.get().auth !== "signed-in") return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const s = this.store.get();
    const selection = { model: s.model, mode: s.mode };
    this.store.set({ busy: true, error: "" });
    try {
      let frame,
        history = null;
      if (s.source === "sample") {
        frame = await this.api.post(
          "/api/replay/step",
          {
            ...selection,
            scenario: s.scenario,
            run_id: s.runId,
            index: s.nextIndex,
            harsh: s.harsh,
            inject,
          },
          { signal },
        );
      } else if (s.source === "synthetic") {
        frame = await this.api.post(
          "/api/synthetic/step",
          { ...selection, run_id: s.runId, index: s.nextIndex },
          { signal },
        );
      } else if (s.source === "fleet") {
        const vehicle = s.vehicles.find(
          (v) => v.internal_vehicle_id === s.vehicleId,
        );
        if (!vehicle)
          throw new Error(
            "Choose a discovered vehicle before starting live monitoring.",
          );
        frame = await this.api.post(
          "/api/monitor/tick",
          {
            ...selection,
            connection_id: vehicle.connection_id,
            external_vehicle_id: vehicle.external_vehicle_id,
          },
          { signal },
        );
      } else if (s.source === "device") {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(s.deviceId))
          throw new Error(
            "Enter a device ID using letters, numbers, dashes or underscores.",
          );
        const result = await this.api.get(
          "/api/state?vehicle_id=" + encodeURIComponent(s.deviceId),
          { signal },
        );
        frame = result.frame;
        history = result.history;
        if (
          frame &&
          (frame.selected_model !== s.model || frame.mode !== s.mode)
        ) {
          const evaluation = await this.api.post(
            "/api/evaluate",
            {
              ...selection,
              telemetry: frame.telemetry,
              gps: frame.gps,
              context: frame.context,
            },
            { signal },
          );
          frame = { ...frame, ...evaluation };
        }
      } else {
        frame = await this.api.post(
          "/api/legacy/tick",
          { ...selection, vehicle_id: s.deviceId },
          { signal },
        );
      }
      if (epoch !== this.epoch) return;
      if (frame) {
        const current = this.store.get();
        this.store.set({
          ...acceptFrame(current, frame, history),
          nextIndex: sampleSource(s.source)
            ? (frame.replay?.index ?? s.nextIndex) + 1
            : s.nextIndex,
          phase: frame.complete
            ? "complete"
            : this.playing
              ? "running"
              : "paused",
          busy: false,
          error: "",
        });
      } else this.store.set({ phase: "waiting", busy: false });
      if (frame?.complete) this.playing = false;
      if (this.playing) {
        const latest = this.store.get();
        const sourceDelay =
          (Number(frame?.replay?.sourceDeltaSec || 1) * 1000) / latest.speed;
        const delay = sampleSource(s.source)
          ? Math.max(
              300,
              latest.compressGaps ? Math.min(2000, sourceDelay) : sourceDelay,
            )
          : Number(frame?.fleet_api?.poll_interval_sec || 5) * 1000;
        this.timer = setTimeout(() => this.tick(epoch), delay);
      }
    } catch (error) {
      if (epoch === this.epoch && !signal.aborted) this.fail(error);
    } finally {
      if (epoch === this.epoch) {
        this.abort = null;
        this.store.set({ busy: false });
      }
    }
  }
  async selectModel(model, mode = this.store.get().mode) {
    const wasPlaying = this.playing,
      complete = this.store.get().phase === "complete";
    this.stop();
    const epoch = this.epoch;
    this.store.set({
      model,
      mode,
      busy: false,
      error: "",
      phase: complete
        ? "complete"
        : this.store.get().frame
          ? "paused"
          : "ready",
    });
    const frame = this.store.get().frame;
    if (!frame) {
      if (wasPlaying) this.start();
      return;
    }
    this.abort = new AbortController();
    this.store.set({ busy: true });
    try {
      const values = await this.api.post(
        "/api/evaluate",
        {
          model,
          mode,
          telemetry: frame.telemetry,
          gps: frame.gps,
          context: frame.context,
        },
        { signal: this.abort.signal },
      );
      if (epoch !== this.epoch) return;
      this.store.set({ frame: { ...frame, ...values }, busy: false });
      if (wasPlaying) this.start();
    } catch (error) {
      if (epoch === this.epoch && error.name !== "AbortError") this.fail(error);
    } finally {
      if (epoch === this.epoch) this.store.set({ busy: false });
    }
  }
  async loadConnections() {
    const auth = this.authEpoch,
      id = ++this.connectionRequest;
    this.store.set({ connectionsLoading: true, connectionError: "" });
    try {
      const data = await this.api.get("/api/connections");
      if (auth === this.authEpoch && id === this.connectionRequest)
        this.store.set({ connections: data.connections });
    } catch (error) {
      if (auth === this.authEpoch && id === this.connectionRequest)
        this.store.set({ connectionError: error.message });
    } finally {
      if (auth === this.authEpoch && id === this.connectionRequest)
        this.store.set({ connectionsLoading: false });
    }
  }
  async discover() {
    const auth = this.authEpoch,
      id = ++this.fleetRequest,
      epoch = this.epoch;
    this.store.set({ fleetLoading: true, fleetError: "" });
    this.loadConnections();
    try {
      const result = await this.api.post("/api/fleet/discover");
      if (auth !== this.authEpoch || id !== this.fleetRequest) return;
      this.store.set({
        vehicles: result.vehicles,
        connectionResults: result.connections,
      });
      if (
        epoch === this.epoch &&
        this.store.get().source === "fleet" &&
        !result.vehicles.some(
          (v) => v.internal_vehicle_id === this.store.get().vehicleId,
        )
      )
        this.store.set({
          vehicleId: result.vehicles[0]?.internal_vehicle_id || "",
        });
    } catch (error) {
      if (auth === this.authEpoch && id === this.fleetRequest)
        this.store.set({ fleetError: error.message });
    } finally {
      if (auth === this.authEpoch && id === this.fleetRequest)
        this.store.set({ fleetLoading: false });
    }
  }
  async selectVehicle(vehicleId) {
    this.stop();
    const epoch = this.epoch;
    this.store.set({ vehicleId, ...blankData() });
    if (!vehicleId) return;
    try {
      const data = await this.api.get(
        "/api/state?vehicle_id=" + encodeURIComponent(vehicleId),
      );
      if (epoch === this.epoch && data.frame)
        this.store.set({
          ...acceptFrame(this.store.get(), data.frame, data.history),
          phase: "paused",
        });
    } catch (error) {
      if (epoch === this.epoch) this.store.set({ error: error.message });
    }
  }
}
