# CALIBR8 Render + Supabase Dashboard v5

This edition removes Firebase and Google Cloud billing requirements.

## Architecture

- **Render Free Web Service**: hosts the HTML/CSS/JS dashboard and FastAPI backend in one service.
- **Supabase Free**: Authentication, Postgres persistence, and Realtime updates.
- **OpenStreetMap + Leaflet**: route visualization.
- **CALIBR8 models**: XGBoost + LightGBM ensemble, Friend GBM, and the physics engine run in Python on Render.

## What is retained from v4

- One organization/customer workspace.
- Multiple customer live API connections.
- Automatic vehicle discovery from each API.
- Vehicle selector: monitor one car at a time.
- Live route, telemetry, braking physics, harsh-event history.
- New CALIBR8-AI ↔ Friend GBM switch.
- Balanced and Safety thresholds for New AI.
- Sample API replay, harsh-event replay, manual harsh-event injection.
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
