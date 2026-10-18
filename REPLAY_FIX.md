# CALIBR8 5.2.2 — replay startup and source controls

## What caused the confusing first load

The initial HTML showed the replay route and playback bar while the configured data source was **Live fleet APIs**. After JavaScript initialized, it hid those replay controls and showed the live vehicle selector. An empty fleet then had no vehicle to monitor. The controls had briefly represented a different source from the one selected.

There was also a startup/source-switch failure when Chart.js did not load. The browser exposes the canvas with `id="telemetryChart"` as `window.telemetryChart`. The application treated that canvas as a chart instance and called `.update()` on it, interrupting view reset and source switching. The chart instance now uses a separate module variable, so replay and measurements work even when the chart library is unavailable.

## Updated behavior

- Replay controls remain hidden in the initial HTML and appear when a replay source is selected.
- **Run sample replay** starts a sample route directly, without a live vehicle or customer API connection.
- Choosing a replay source from the dropdown shows **Ready to start**. Choose a route and press **Start**.
- A source selected while the workspace loads is preserved when the background requests finish.
- **View API output** opens the current payload in **Models & physics**.
- Failed replay tick requests pause playback, show the error beside the controls and allow **Start** to retry.
- The existing sign-in, measurement and theme fixes remain included.

The sample runs through the deployed backend and your existing Supabase session. It still needs the Render service and Supabase to be configured and available.

## Apply to the current deployment

1. Extract this ZIP and replace these files in the existing repository:

```text
public/app.js
public/index.html
public/style.css
```

2. Commit/push and deploy the latest commit on the existing Render service.
3. After deployment, open the dashboard and press **Ctrl+Shift+R** to load the new assets.
4. Sign in, then click **Run sample replay**.
5. Confirm speed, braking and physics readings update. Use **View API output** to inspect the sample response.

No database migration or new environment variable is required. The complete project can also replace the existing project-folder contents. The new asset query version is `5.2.2-replay`.

## Verification

Local DOM integration tests passed for:

- Empty-fleet startup with Chart.js and Leaflet unavailable.
- Starting the sample while workspace loading is delayed, and preserving it when loading finishes.
- Switching between live fleet and sample replay, manual Start and API-output navigation.
- Replay HTTP failure, visible error and successful retry.
- Measurement/physics/chart updates, harsh-event injection, model switching and state fallback.
- Sign-in, saved sessions, sign-out and token refresh, including the actual Supabase SDK with mocked Auth HTTP responses.
- Light/dark/system themes, navigation, search and the API connection form.

These checks use mocked network transport and real backend-generated measurement fixtures. They do not verify the deployed Render service or your Supabase account. `UI_PREVIEW.html` is an offline design demonstration; run the deployed dashboard for simulation and sign-in.

To run the regression checks, install the development dependencies from `LOGIN_FIX.md`, generate the fixture JSON as described in `MEASUREMENTS_FIX.md`, then run:

```sh
node scripts/test_replay_flow.cjs dashboard_fixtures.json
node scripts/test_dashboard_ui.cjs dashboard_fixtures.json
node scripts/test_auth_flow.cjs
```
