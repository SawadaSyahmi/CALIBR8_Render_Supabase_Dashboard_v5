# Upgrade from the earlier CALIBR8 dashboard

## Use the complete source

The frontend, authentication layer, playback controller, API orchestration and database repository were rebuilt. Replace the project source with this complete folder. Old `public/app.js`, `public/ui.js`, `public/style.css` and `public/calibr8-config.js` are no longer used. The new entry points are `public/index.html`, `public/styles.css` and `public/js/app.js`.

The backend still starts with `backend.app.main:app` and uses the existing model/data filenames. Keep the existing Render service URL, Supabase project, accounts and encryption key.

## Database migration

Run the included `supabase_schema.sql` once. It is rerunnable and preserves existing tables, connections, routes and events. It enables authenticated CRUD policies for the single organization and adds three functions:

- `calibr8_commit_frame`: transactionally saves a complete live measurement, route point, event and trip counters.
- `calibr8_reset_vehicle`: starts a new trip and preserves previous history.
- `calibr8_schema_version`: checks the migration from the workspace UI.

Retries deduplicate points/events within a trip. Vehicle IDs use the original v5/v6 mapping so saved histories stay associated with their vehicle. Old route/event row IDs are restored when loading history. Older inference snapshots have a different format and are replaced by a new complete snapshot on the next live poll.

All manually authorized Supabase users share this organization's data, as in the no-service-role edition. Disable public account registration in Supabase Auth. The migration does not add per-user tenants or roles.

## Authentication

Sign in once after deploying. The rebuilt application uses HttpOnly cookies scoped to the same service's `/api` paths, rather than the old browser SDK/local-storage session. The server validates the user with Supabase and refreshes expired sessions through the same-origin API.

`SUPABASE_PUBLISHABLE_KEY` and the earlier `SUPABASE_ANON_KEY` are accepted. The service-role key is not read. Retain `CONNECTION_ENCRYPTION_KEY` so existing saved API headers remain usable.

## Source behavior

The initial source is **Sample API replay**, ready for Start. Opening the workspace does not automatically discover live APIs or begin playback. The three recorded routes and the controlled harsh event remain included.

Sample playback and synthetic driving are isolated browser sessions and are not saved to live vehicle history. Export sample events before resetting or refreshing. Live monitoring and device uploads save complete frames through Supabase. The API-output view shows any failed save separately from successful source readings.

The model binaries, preprocessing metadata, physics calculation and recorded-route assets are retained from the earlier project. Ordinary GPS-only live braking values remain estimates, with an explicit quality note in the UI.

## Device integrations

The preferred device endpoint is now `POST /api/ingest` with one complete telemetry/GPS/context bundle. It requires the user's Bearer token and the configured ingest key. Update integrations that used the old separate telemetry/GPS/context upload endpoints; those routes are not part of the rebuilt API.

The rotating public sample endpoint remains `/api/mock/live`. See `API.md` for current request/response contracts. Legacy three-endpoint pull is still available when its three URLs are configured on the server.
