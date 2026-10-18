export const newRunId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
export const blankData = () => ({
  frame: null,
  route: [],
  events: [],
  chart: [],
  nextIndex: 0,
  runId: newRunId(),
  error: "",
  phase: "ready",
  busy: false,
});

export function createStore() {
  let state = {
    auth: "loading",
    user: null,
    view: "overview",
    source: "sample",
    scenario: "route_1",
    harsh: false,
    speed: 10,
    compressGaps: true,
    model: "new_ai",
    mode: "balanced",
    deviceId: "device_vehicle",
    vehicleId: "",
    connections: [],
    vehicles: [],
    connectionResults: [],
    fleetLoading: false,
    connectionsLoading: false,
    connectionError: "",
    fleetError: "",
    health: null,
    bootError: "",
    ...blankData(),
  };
  const subscribers = new Set();
  return {
    get: () => state,
    set(patch) {
      state = {
        ...state,
        ...(typeof patch === "function" ? patch(state) : patch),
      };
      for (const fn of subscribers) fn(state);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

export function mergeById(first, second, key, limit = 500) {
  const map = new Map(first.map((row) => [row[key], row]));
  for (const row of second) if (row?.[key]) map.set(row[key], row);
  return [...map.values()].slice(-limit);
}

export function acceptFrame(state, frame, history = null) {
  if (
    frame?.schema_version !== 7 ||
    !frame.frame_id ||
    !frame.telemetry ||
    !frame.gps ||
    !frame.decision ||
    !frame.models?.new_ai ||
    !frame.models?.friend_gbm
  )
    throw new Error("Incomplete measurement response. Please retry.");
  const previousTrip = state.frame?.trip?.active_trip_id;
  const nextTrip = frame.trip?.active_trip_id;
  const changed = previousTrip && nextTrip && previousTrip !== nextTrip;
  const routePoint = (point) =>
    point && { ...point, id: point.frame_id || point.id };
  const eventPoint = (event) =>
    event && { ...event, event_id: event.frame_id || event.event_id };
  const route = mergeById(
    changed ? [] : state.route,
    [...(history?.route || []), frame.route_point].map(routePoint),
    "id",
  );
  const events = mergeById(
    changed ? [] : state.events,
    [...(history?.events || []).slice().reverse(), frame.event].map(eventPoint),
    "event_id",
    1000,
  );
  const sample = {
    id: frame.frame_id,
    timestamp: frame.server_time,
    speed: frame.gps.speed_kmh ?? frame.telemetry.post_event_speed_kmh,
    decel: Math.abs(frame.telemetry.peak_deceleration_mps2),
  };
  const chart = mergeById(changed ? [] : state.chart, [sample], "id", 60);
  return { frame, route, events, chart };
}
