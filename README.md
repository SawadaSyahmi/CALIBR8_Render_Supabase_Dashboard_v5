# CALIBR8 Fleet Intelligence — 7.0.0

A rebuild of the dashboard application around explicit source state, same-origin authentication and complete measurement snapshots. Start with **START_HERE.md** if you are updating the existing Render service.

## Included

- Responsive Light, Dark and System themes across sign-in and the workspace.
- Recorded sample routes, controlled harsh-event injection, synthetic driving and a public rotating sample API.
- Multiple saved live API connections, nested JSON field mapping, encrypted request headers and vehicle discovery.
- Live monitoring, route history, braking estimates, physics calculations and both AI model results.
- Device uploads, optional legacy three-API pull, event search and CSV export.
- A raw API output view and a workspace connection check.
- Existing CALIBR8 preprocessor, XGBoost, LightGBM, Friend GBM, model metadata, physics calculation and recorded route assets.

The frontend uses local ES modules and native SVG for charts and routes. OpenStreetMap tile images are optional background imagery; failed tiles do not stop measurements or route plotting. No frontend package build or external JavaScript CDN is required.

## Runtime structure

```text
backend/app/auth.py        Supabase password sign-in, cookie sessions and validation
backend/app/engine.py      Complete frames from the original trained models and physics
backend/app/main.py        FastAPI routes and application lifecycle
backend/app/repository.py  Explicit user-token database access
backend/app/connections.py API normalization, request headers and GPS estimates
backend/app/replay.py      Recorded sample route preparation
backend/models/           Original trained assets
backend/data/             Recorded routes
public/js/api.js          Requests, timeouts and one shared refresh operation
public/js/controller.js   Playback, cancellation and source transitions
public/js/store.js        State and history deduplication
public/js/app.js          UI rendering and user interactions
public/js/map.js           SVG route plotting and optional map images
public/js/chart.js         Local telemetry chart
supabase_schema.sql       Tables, RLS and atomic live-frame save functions
```

Sample playback is stateless on the server: the browser requests an explicit route index and accepts the resulting complete frame. Live monitoring saves a frame in one transactional database function. A database save failure is reported alongside the latest measurements. Source changes cancel older requests and invalidate their responses.

All authorized users share one organization workspace. Create authorized users manually in Supabase and disable public sign-up. Database requests use the signed-in user's access token and a publishable/anon key; the application does not read a service-role key.

## Development

Python 3.12:

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
```

Copy `backend/.env.example` to `backend/.env` and fill in your configuration, then:

```sh
uvicorn backend.app.main:app --env-file backend/.env --reload
```

Open `http://127.0.0.1:8000`. Open the application through the server; opening `index.html` directly cannot run the API or sign-in flow.

## Tests

The tests use real trained models, mocked Supabase/external API transport, and an embedded PostgreSQL engine. They do not need your account credentials.

```sh
python -m unittest discover -s tests -p test_backend.py -v
npm install
npm test
```

To regenerate the frontend fixtures from backend results:

```sh
# PowerShell:
$env:CALIBR8_TEST_FIXTURES="tests/fixtures.json"
python -m unittest discover -s tests -p test_backend.py -v
```

See `TESTING.md` for coverage and verification limits.
