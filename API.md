# API reference

The frontend and API share the same origin. Browser requests use the HttpOnly session cookies set by sign-in. Device/server clients use a Supabase user access token in `Authorization: Bearer USER_ACCESS_TOKEN`.

## Authentication

| Method | Route               | Purpose                                                   |
| ------ | ------------------- | --------------------------------------------------------- |
| POST   | `/api/auth/login`   | Email/password sign-in; returns the user and sets cookies |
| GET    | `/api/auth/session` | Validate the current session                              |
| POST   | `/api/auth/refresh` | Refresh through the HttpOnly refresh cookie               |
| POST   | `/api/auth/logout`  | End this browser's session and clear its cookies          |
| GET    | `/api/health`       | Public service/configuration status                       |
| GET    | `/api/diagnostics`  | Authenticated database and migration check                |

Login body:

```json
{ "email": "authorized@example.com", "password": "YOUR_PASSWORD" }
```

The application has no built-in account or default password. Create the authorized account in Supabase Authentication.

## Sample replay

`POST /api/replay/step` is authenticated and does not read or write the live database:

```json
{
  "run_id": "my-sample-session",
  "scenario": "route_1",
  "index": 0,
  "model": "new_ai",
  "mode": "balanced",
  "harsh": false,
  "inject": false
}
```

Use a new `run_id` when restarting. Increment `index` after each successful response. `harsh=true` injects one controlled event at the route's configured test point. `inject=true` injects a controlled event at the requested point. The response reports `complete=true` at the last route point; the UI stops rather than silently looping.

Other sample routes:

| Method | Route                                      | Purpose                                                           |
| ------ | ------------------------------------------ | ----------------------------------------------------------------- |
| GET    | `/api/replay/scenarios`                    | Included route metadata                                           |
| POST   | `/api/synthetic/step`                      | Generated drive; body includes `run_id`, `index`, `model`, `mode` |
| GET    | `/api/mock/live?scenario=route_1`          | Public rotating sample, advances every five seconds               |
| GET    | `/api/mock/live?scenario=route_1&index=10` | Public point selected explicitly for a test                       |
| GET    | `/api/mock/harsh-event?scenario=route_1`   | Public controlled harsh-event example                             |

The public mock feed returns an array matching the included GPS API format. Its fields include `deviceId`, `dateTime`, `latitude`, `longitude`, `speed`, and replay metadata. These are recorded/simulated test values.

## Complete measurement frame

Replay, synthetic, live-monitor and ingest endpoints return the same main contract:

```text
schema_version: 7
frame_id, vehicle_id, source, server_time
telemetry: pre/post speed, speed drop, peak/mean deceleration, jerk, duration, quality
gps: lat, lon, speed_kmh, heading_deg, timestamp
context: vehicle, road, traffic, weather, surface, grade
physics: friction, traction, braking capability, utilisation, classification
models: {new_ai, friend_gbm}
selected_model, mode, decision
trip, route_point, event
raw_api_output
quality: {note}
persistence: {saved, message}
replay, harsh_event, complete  (sample only)
fleet_api, source_point       (live API only)
```

`persistence.saved=false` on sample frames is expected: they belong to the temporary sample session. On a live/device frame, it reports a failed save separately from a successful measurement calculation. Retry IDs are deterministic within the active trip so repeated delivery does not add extra route points or events.

`POST /api/evaluate` accepts `telemetry`, `gps`, `context`, `model` and `mode`. It recomputes a current measurement without advancing playback or saving a second event.

## Live API connections

| Method | Route                                               | Purpose                                            |
| ------ | --------------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/connections`                                  | Saved connections; secret headers are excluded     |
| POST   | `/api/connections`                                  | Add/update a connection                            |
| DELETE | `/api/connections/{connection_id}`                  | Remove a connection; keeps trip history            |
| POST   | `/api/connections/{connection_id}/test`             | Fetch and normalize vehicles                       |
| POST   | `/api/fleet/discover`                               | Discover vehicles across enabled connections       |
| POST   | `/api/monitor/tick`                                 | Read and evaluate one selected vehicle             |
| GET    | `/api/state?vehicle_id=...`                         | Latest complete frame and current trip history     |
| POST   | `/api/vehicle/reset`                                | Start a new live trip; body `{"vehicle_id":"..."}` |
| GET    | `/api/export/events.csv?vehicle_id=...&trip_id=...` | Current trip's recent events as CSV                |

Monitor body:

```json
{
  "connection_id": "SAVED_CONNECTION_ID",
  "external_vehicle_id": "CAR-1",
  "model": "new_ai",
  "mode": "balanced"
}
```

The connection form exposes all saved settings. Field paths support nested records (for example `vehicle.id`), with an optional list root (`data.vehicles`). Speed units are `kmh`, `mph` or `mps`; timestamps use `epoch_seconds`, `epoch_milliseconds` or `iso`.

Records require valid device IDs, GPS coordinates, speed and timestamps. Invalid records are skipped instead of fabricating a current timestamp or zero speed. GPS-only braking estimates use the actual time interval; the UI marks them as estimates.

## Device upload

`POST /api/ingest` accepts one complete bundle. Send both:

```text
Authorization: Bearer USER_ACCESS_TOKEN
X-CALIBR8-INGEST-KEY: YOUR_CONFIGURED_INGEST_KEY
Content-Type: application/json
```

Example body:

```json
{
  "vehicle_id": "device_vehicle",
  "model": "new_ai",
  "mode": "balanced",
  "telemetry": {
    "pre_event_speed_kmh": 60,
    "post_event_speed_kmh": 40,
    "speed_drop_kmh": 20,
    "peak_deceleration_mps2": -6.5,
    "mean_deceleration_mps2": -4.55,
    "max_jerk_mps3": -13,
    "event_duration_sec": 1.3,
    "timestamp_start": "2026-10-18T07:00:00Z"
  },
  "gps": {
    "lat": 3.139,
    "lon": 101.687,
    "speed_kmh": 40,
    "timestamp": "2026-10-18T07:00:00Z"
  },
  "context": {
    "vehicle_type": "passenger_car",
    "road_type": "urban",
    "traffic_density": "medium",
    "weather": "clear",
    "road_surface": "dry_asphalt",
    "road_grade_ratio": 0
  }
}
```

Select **Device / API push** in the dashboard, enter the same vehicle ID, and press **Watch device**. User access tokens expire; a device client must maintain its own Supabase session. The ingest key alone does not grant database access in this edition.

Legacy pull uses `POST /api/legacy/tick` with `vehicle_id`, `model` and `mode`, after the three endpoint URLs are configured on the server.
