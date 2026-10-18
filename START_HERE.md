# CALIBR8 — rebuilt project

This is the complete rebuilt application. Deploy this project as a whole; the older UI patches are not needed.

## Update your existing Render deployment

1. Extract the ZIP and open `CALIBR8_Rebuilt_v7`.
2. Replace the application source in your GitHub repository with this folder's contents. Keep your existing Git history and Render service.
3. In your existing Supabase project, open **SQL Editor**, paste `supabase_schema.sql`, and run it once. It adds the new save functions and access policies without deleting existing connections or history.
4. In Render, keep `SUPABASE_URL` and your current `CONNECTION_ENCRYPTION_KEY`. Set **either** `SUPABASE_PUBLISHABLE_KEY` **or** your existing `SUPABASE_ANON_KEY`. A service-role key is not used.
5. Use these Render commands:

```text
Build: pip install --upgrade pip && pip install -r backend/requirements.txt
Start: uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips '*'
Health check: /api/health
```

6. Use Python **3.12.14** and retain the thread-limit environment variables shown in `render.yaml`.
7. Commit/push the complete source and deploy the latest commit.
8. Open the existing dashboard URL and press **Ctrl+Shift+R**. Sign in once with your existing Supabase email/password.

The rebuilt sign-in uses a server-managed cookie session. The old browser session is not imported. Your account and password remain the same.

## First check after deployment

1. The workspace should open with **Sample API replay** selected and **Ready to start** visible.
2. Press **Start replay**. Route points, speed, braking, physics and both AI scores should update together. Zero speed is valid when a recorded vehicle is stationary.
3. Press **Inject harsh event**. Peak deceleration should show **−6.50 m/s²**, jerk **−13.00 m/s³**, and the event should appear under **Safety events**.
4. Open **API output** to see the current JSON response.
5. Open **Workspace settings → Check connection**. It checks your session, database access and installed functions.
6. Try Light and Dark themes, sign out, then sign in again.

Sample playback needs authentication and the backend, but it does not need live API connections or database writes. Sample events stay in the current session; export them before starting again or refreshing the page.

## Connect real vehicles

Open **Fleet & connections → Add connection**. Enter the endpoint and, if needed, request headers, field mapping and default conditions. Save, test, then refresh the fleet. Choose **Monitor vehicle** for the car you want to view.

Existing saved API connections use the same encryption format. Keep the old `CONNECTION_ENCRYPTION_KEY` so their headers can still be read.

See `DEPLOYMENT.md` for a new installation, `MIGRATION.md` for compatibility details, and `API.md` for device uploads.
