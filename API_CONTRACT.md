# CALIBR8 v5 API Contract

All dashboard management/model endpoints require a valid **Supabase access token** in:

```http
Authorization: Bearer <access_token>
```

Direct device push uses:

```http
X-CALIBR8-INGEST-KEY: <INGEST_API_KEY>
```

## Health / configuration

```http
GET /api/health
GET /api/client-config
```

`/api/client-config` exposes only the Supabase URL and anon key required by the browser. It never exposes the service-role key.

## Customer live API connections

```http
GET    /api/connections
POST   /api/connections
DELETE /api/connections/{connection_id}
POST   /api/connections/{connection_id}/test
```

The default field mapping matches the provided sample feed:

```text
deviceId  -> device ID
dateTime  -> timestamp
latitude  -> latitude
longitude -> longitude
speed     -> speed
direction -> heading
```

## Fleet discovery / monitoring

```http
POST /api/fleet/discover
GET  /api/fleet
POST /api/monitor/tick
```

`/api/monitor/tick` polls only the selected vehicle's source API, normalizes the latest point, derives braking telemetry from GPS speed when necessary, updates Supabase, runs physics + both AI models, and returns the selected inference.

## Inference

```http
POST /api/inference
```

Example:

```json
{
  "vehicle_id": "ext_api123_abcd1234",
  "model": "new_ai",
  "mode": "balanced"
}
```

Supported model keys:

- `new_ai`
- `friend_gbm`

New AI modes:

- `balanced`
- `safety`

## Replay/demo

```http
GET  /api/replay/scenarios
GET  /api/mock/live?scenario=route_1
GET  /api/mock/harsh-event?scenario=route_3
POST /api/replay/tick
POST /api/replay/harsh/tick
POST /api/replay/inject
POST /api/replay/reset
POST /api/demo/tick
```

## Direct push

```http
POST /api/ingest/telemetry?vehicle_id=<id>
POST /api/ingest/gps?vehicle_id=<id>
POST /api/ingest/context?vehicle_id=<id>
```

## Export

```http
GET /api/export/events.csv?vehicle_id=<id>&trip_id=<trip_id>
```


## Dashboard response and state fallback (v5.1)

Replay, fleet-monitoring, demo, sync and inference responses include `vehicle_id`, `telemetry`, `gps`, `context`, `physics`, `inference`, `model_comparison`, `trip`, `route_point` and `event`. The latter two may be null. The UI renders these responses immediately.

`GET /api/state?vehicle_id=<id>` requires the same Bearer authentication as the dashboard APIs. It returns `vehicle_id`, `live` (the stored telemetry, GPS, context, trip, inference and raw-source values), `route_points` (latest 500, chronological) and `events` (latest 50). It reads the selected vehicle and active trip only. It does not return connection credentials.
