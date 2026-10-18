# CALIBR8 5.2 — professional dark and light interface

## What changed

- A workspace sidebar with Live monitoring, Fleet, Safety events, and Models & physics.
- A focused monitoring page: current readings first, followed by the route, braking assessment, telemetry chart and driving conditions.
- Light, Dark and Auto appearance controls. The choice is remembered on this browser. Auto follows the operating-system preference.
- Theme-aware charts, map treatment, status colours, forms, dialogs and sign-in screen.
- Search by vehicle/connection in Fleet and by event details in Safety events.
- A compact replay toolbar and expandable model configuration.
- A responsive mobile navigation drawer, keyboard focus indicators, Escape-to-close connection dialog, focus restoration, password visibility control and copy-payload action.
- Clear sample/replay labels and waiting states for missing measurements.

The API-response measurement fix from 5.1 is included. Replay, live monitoring, both AI models, physics, event history and API connection management use the existing backend.

## Preview the design

Open `UI_PREVIEW.html` directly in a browser. It is self-contained and makes no live API requests. You can switch Light/Dark/Auto themes, browse the four views, preview the sign-in screen and switch between the recorded normal sample and the controlled harsh-braking sample.

The preview map is a schematic drawn from recorded Route 1 coordinates. Its background grid illustrates the layout; it is not a street basemap. The deployed dashboard uses the existing OpenStreetMap/Leaflet integration. Preview readings come from local test outputs, and the injected harsh event is synthetic. Live controls and API setup require the deployed application.

## Update your existing Render deployment

1. Extract the ZIP.
2. Replace the matching files in your existing GitHub repository with the project-folder contents. Keep `render.yaml`, `public` and `backend` at the repository root.
3. Commit and push, then deploy the latest commit in your existing Render service.
4. Open the dashboard and press **Ctrl+Shift+R**.
5. Sign in with your existing Supabase account.
6. Use the appearance controls in the top bar to select **Light**, **Dark** or **Auto**.
7. Test **Sample API replay → Start → Inject harsh event**, then switch between the AI models and open the other views.

Use the existing Supabase project, login accounts, saved connections and Render environment variables. This UI update does not require a database migration.

The new frontend consists of four files:

```text
public/index.html
public/style.css
public/ui.js
public/app.js
```

If your deployed project already contains the full 5.1 measurement fix, these four files are sufficient for the UI update. Otherwise deploy the complete package to include the backend response/state fixes too. The existing model binaries are included.

## Verification

- JavaScript syntax checks passed for both application and UI scripts.
- The actual page/application code passed DOM integration checks for measurement updates, both themes, remembered theme choice, theme-aware chart colours, four-view navigation, mobile-menu controls, connection-dialog dismissal/focus, password visibility, fleet/event search, API field mappings and visible save confirmation.
- The monitoring regression checks still cover replay, injected braking, model switching, route/event/chart deduplication, push-state fallback, auth token refresh and vehicle selection with zero Realtime data messages.
- The standalone preview passed script, theme, navigation, sign-in-preview and sample-event checks.
- Principal text/status colour combinations were checked for at least 4.5:1 contrast in both themes.
- Responsive breakpoints cover desktop, tablet and phone widths. These checks use a DOM environment, not browser pixel-layout validation; the user's live Render/Supabase deployment has not been accessed.

For optional test commands, see `MEASUREMENTS_FIX.md`. The frontend checks now also load `public/ui.js` and verify the new interface controls.
