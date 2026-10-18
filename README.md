# CALIBR8 Render + Supabase Dashboard v5.2.2

This edition fixes replay startup and source controls, and includes the sign-in fix, dark/light interface and measurement display fix. Read `REPLAY_FIX.md` to update an existing deployment. The earlier changes are described in `LOGIN_FIX.md`, `UI_REDESIGN.md` and `MEASUREMENTS_FIX.md`. Open `UI_PREVIEW.html` for a self-contained design preview.

The dashboard has Live monitoring, Fleet, Safety events and Models & physics views, with remembered Light/Dark/Auto themes and responsive navigation. Measurement cards update directly from API responses, with Realtime updates and authenticated state reads for history and fallback.

## Architecture

- **Render Free Web Service**: hosts the HTML/CSS/JS dashboard and FastAPI backend in one service.
- **Supabase Free**: Authentication, Postgres persistence, and Realtime updates.
- **OpenStreetMap + Leaflet**: route visualization.
- **CALIBR8 models**: XGBoost + LightGBM ensemble, Friend GBM, and the physics engine run in Python on Render.

## Features

- Light, Dark and Auto themes across the workspace and sign-in screen.
- Four navigation views, fleet/event search and responsive mobile navigation.
- One organization/customer workspace.
- Multiple customer live API connections.
- Automatic vehicle discovery from each API.
- Vehicle selector: monitor one car at a time.
- Live route, telemetry, braking physics, harsh-event history.
- New CALIBR8-AI ↔ Friend GBM switch.
- Balanced and Safety thresholds for New AI.
- Sample API replay, harsh-event replay, manual harsh-event injection.
- One-click sample replay without a live fleet connection, visible playback errors and an API-output shortcut.
- Direct device/API push endpoints.
- CSV event export.
- Encrypted saved API request headers.

## Supabase tables

`supabase_schema.sql` creates:

- `workspace`
- `api_connections` — backend-only; contains encrypted headers.
- `fleet`
- `live_state`
- `trips`
- `route_points`
- `events`

Authenticated dashboard users can read fleet/live/route/event data. Browser writes are blocked by Row Level Security. The Render backend uses the Supabase service-role key for server-side writes.

## Quick start

1. Create a free Supabase project.
2. Run `supabase_schema.sql` in Supabase SQL Editor.
3. Enable Email/Password Auth and create at least one user.
4. Push this project to GitHub.
5. On Render: **New > Blueprint** and select the repository, or create a Python Web Service using `render.yaml`.
6. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `CONNECTION_ENCRYPTION_KEY` in Render.
7. Deploy and open the generated `https://<service>.onrender.com` URL.

See `DEPLOYMENT.md` for the full walkthrough.

## Important free-tier behavior

Render Free can spin down after inactivity, so the first request after a quiet period may be slow. Supabase Free projects can also pause after prolonged low activity. This build is suitable for research prototypes, demonstrations, and progress reviews; a continuously available customer production service should eventually use paid compute.
