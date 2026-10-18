# CALIBR8 5.1 — measurement display fix

For the 5.2 interface update, follow `UI_REDESIGN.md`. The full package includes this measurement fix.

## What caused the zeros

In the original dashboard, a successful replay/live API response updated only the raw source-output panel. The measurement cards, physics panel, trip summary, chart and event history depended on separate Supabase Realtime messages. When those messages did not arrive, the source advanced while the other panels kept their initial values.

The corrected dashboard applies each successful API response to the measurement cards immediately. It also receives the current trip, latest stored route point and detected event in that response. Realtime can deliver additional updates. An authenticated `/api/state` endpoint restores history when the page opens and supplies periodic reads for device-push monitoring or interrupted updates.

The Speed card now shows the current GPS/post-event speed. Pre-event speed remains an input to the braking models. Missing readings display `—` while waiting for data. Duplicate HTTP/Realtime delivery does not add duplicate route points, chart samples or event rows. Vehicle switches discard results for a previously selected view. Token refresh keeps the current view.

## Update your current deployment

1. Extract this ZIP.
2. Copy the **contents** of its project folder into your existing CALIBR8 GitHub repository, replacing the matching files. `render.yaml`, `backend` and `public` should be at the repository root.
3. Commit/push the changes, then deploy the latest commit in your existing Render service.
4. Open the dashboard and press **Ctrl+Shift+R** to refresh the JavaScript.
5. Sign in using your existing Supabase account.
6. Select **Sample API replay**, choose Route 1 and press **Start**. The measurement cards and map route should update as replay advances.
7. Press **Inject Harsh Event Now**. Expect peak deceleration `-6.50 m/s²`, jerk `-13.00 m/s³`, a harsh-braking decision and an event-history entry. These values are a controlled test injection.
8. Switch between **New CALIBR8-AI** and **Friend GBM**, including while replay is paused.

Use your existing Render environment variables and Supabase tables. This patch uses the existing JSON data columns, so no SQL migration is required.

Minimum runtime files to replace:

- `public/app.js`
- `public/index.html`
- `backend/app/main.py`
- `backend/app/store.py`

Replace frontend and backend files in the same deployment. The remaining files contain the project, tests and documentation.

## Interpreting readings

Braking utilisation and harsh-event count may legitimately be zero during ordinary driving. The injected event is the quickest check of the full braking display. GPS-only deceleration and jerk are estimates from speed samples; they are not direct accelerometer readings. Weather, road surface and grade use the configured connection context unless your integration supplies them.

## Verification completed

- Actual saved XGBoost, LightGBM and Friend GBM models run on all three replay routes.
- Six API/store integration checks cover complete response data, route/distance, harsh-event history, model switching, authentication, trip reset and separation of vehicle histories.
- DOM integration checks run the actual page and application code with mocked authentication/HTTP responses and **zero Realtime data messages**. They verify visible measurements, physics, model probabilities, chart data, route/history updates, duplicate delivery, token refresh and vehicle switching.

The API checks use an in-memory replacement for the Supabase REST transport and a sample external fleet response. They do not connect to your deployed Render/Supabase services. Browser layout, real WebSocket connectivity and your live customer's endpoint have not been tested in your account.

## Run the regression checks locally (optional)

Install the application dependencies from `backend/requirements.txt`. From the project root:

```sh
python -m unittest discover -s backend -p test_dashboard_state.py -v
python backend/test_replay.py
python backend/test_fleet_connections.py
```

For the DOM checks, install the development dependency `jsdom@26.1.0` and generate the HTTP fixture file:

```sh
npm install --no-save --package-lock=false jsdom@26.1.0
CALIBR8_TEST_FIXTURES=/tmp/calibr8-dashboard-fixtures.json python -m unittest discover -s backend -p test_dashboard_state.py
node scripts/test_dashboard_ui.cjs /tmp/calibr8-dashboard-fixtures.json
```

The last example uses a POSIX shell. In PowerShell, set `$env:CALIBR8_TEST_FIXTURES` to a writable local file before running the Python and Node commands.
