# CALIBR8 v5 Architecture — Render + Supabase

```text
Authorized user
     |
     | Supabase Auth session
     v
Render Web Service
  FastAPI + static dashboard
     |
     +--> Customer live API 1 --> vehicle A / B / C
     +--> Customer live API 2 --> vehicle D / E
     +--> Customer live API N --> ...
     |
     +--> API normalization
     +--> GPS-derived braking telemetry when IMU is unavailable
     +--> CALIBR8 physics engine
     +--> New CALIBR8-AI (XGBoost + LightGBM)
     +--> Friend GBM
     |
     v
Supabase Postgres
  fleet
  live_state
  trips
  route_points
  events
     |
     +--> Supabase Realtime --> browser dashboard
```

## Security boundaries

### Browser
The browser only receives the Supabase **anon/public key**, which is intended for client use. It never receives the service-role key or stored customer API secrets.

### FastAPI / Render
Render stores:

- `SUPABASE_SERVICE_ROLE_KEY`
- `CONNECTION_ENCRYPTION_KEY`
- `INGEST_API_KEY`

as server environment variables.

Customer API headers are encrypted before being stored in `api_connections`. The table has RLS enabled with no browser SELECT policy.

### Supabase
Authenticated users may read `fleet`, `live_state`, `trips`, `route_points`, and `events`. They have no direct INSERT/UPDATE/DELETE policies. All writes are performed by the backend with the service-role key.

## Realtime flow

For the selected car, the browser subscribes to:

- `live_state` filtered by `vehicle_id`
- `route_points` filtered by active `trip_id`
- `events` filtered by active `trip_id`

Changing vehicle removes the previous channels and creates new subscriptions for the selected vehicle.
