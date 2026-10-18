# Verification

## Backend and real trained models

`python -m unittest discover -s tests -p test_backend.py -v` runs the real FastAPI application and the included trained models. Supabase Auth/PostgREST and customer API HTTP boundaries are mocked. Coverage includes:

- Password sign-in, HttpOnly/Secure cookies, saved-session validation, refresh, sign-out and expired access.
- Invalid credentials, auth-service failure and cross-site mutation rejection.
- Sample replay while database access is unavailable, with complete telemetry/physics/model results.
- Controlled harsh braking detected by both models, and model re-evaluation.
- All three recorded routes, end-of-route completion, request validation and disabled demo mode.
- Saved API headers encrypted at rest, field mapping, vehicle discovery and GPS-derived braking.
- Repeated source timestamps, visible save failures, device ingestion and diagnostics.
- Invalid records and long GPS intervals without artificial short-interval deceleration.

The generated `tests/fixtures.json` connects actual backend model output to frontend integration checks. It contains only test/sample values.

## Frontend DOM integration

`node --experimental-vm-modules tests/frontend.cjs` loads the actual local ES modules and HTML in JSDOM, without Supabase, Chart.js or Leaflet scripts. It checks:

- Sign-in and sign-out through the returned API result.
- Stable initial source controls and sample startup without live fleet loading.
- Measurement cards, SVG chart/route, harsh events, API output and copy.
- Request failure with retained measurements and successful retry.
- Both themes, System theme, persistence and mobile navigation state.
- Connection form validation, nested mappings, driving context and diagnostics.
- Concurrent 401 responses sharing one refresh operation.
- Late replay responses ignored after changing source.
- Replay completion, new-session reset and live monitoring.
- Late private-data responses ignored after sign-out.
- Stalled response-body timeout and successful retry.
- Save retries deduplicating already displayed points/events.
- Older unauthorized responses ignored after a new successful sign-in.

JSDOM verifies DOM behavior; it does not establish pixel-perfect layout in a real browser.

## Actual database SQL

`node tests/database.cjs` executes `supabase_schema.sql` in PGlite, an embedded PostgreSQL engine. It checks migration reruns, authenticated function execution, anonymous denial, atomic save behavior, retry deduplication, distance/event counters, out-of-order data, failed-write rollback and trip resets that retain old history.

This verifies the supplied SQL itself, independently of the mocked REST service in the API tests. It does not connect to your deployed Supabase instance.

## Run everything

```sh
pip install -r backend/requirements.txt
python -m unittest discover -s tests -p test_backend.py -v
npm install
npm test
```

Frontend test dependencies are development-only; Render does not need Node, JSDOM or PGlite.

## Deployment check

After deploying the complete project and running the SQL migration, use **Workspace settings → Check connection**, then exercise the workflow in `START_HERE.md`. Local regression tests do not replace checking the existing Render service, its environment variables, Supabase policies or a customer's real API.

An optional deployment smoke-check prompts for your existing account and tests a temporary sample without writing live vehicle data:

```sh
python scripts/check_deployment.py https://YOUR_SERVICE.onrender.com
```
