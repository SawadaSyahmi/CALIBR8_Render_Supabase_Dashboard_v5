# CALIBR8 5.2.1 — sign-in screen fix

## Cause reproduced

The previous login form called Supabase `signInWithPassword`, checked only `error`, and cleared its message on success. It did not use the returned session to open the workspace. Screen changes depended entirely on a separate auth notification. A successful Auth HTTP response could therefore leave the sign-in screen visible if the notification was delayed, missed or skipped.

The previous same-user shortcut also mixed the API token helper's `user` variable with workspace-initialization state. Sign-out did not reset that initialization state, and repeated null auth notifications could dereference a null session. Optional map/chart initialization also ran before session restoration and listener registration.

## What changed

- A successful sign-in response opens the workspace directly using the returned session.
- Auth notifications remain an additional path for login, logout and refreshed tokens. They are registered before optional widgets and session restoration.
- Fleet/database loading runs separately from the screen transition. Slow or failed fleet loading does not leave a valid login behind the sign-in screen.
- Duplicate notifications and token refresh do not restart the active workspace.
- Sign-out closes the workspace directly, resets initialization, clears displayed operational data, and invalidates older in-flight workspace reads.
- The API token helper reads the token without changing the UI's session state.
- Errors stay visible, the sign-in button recovers after failed requests, and the password field clears after successful login.
- A map or chart initialization failure does not interrupt auth setup.

Supabase sessions and the backend's Bearer-token validation continue to control access. This patch does not add a default account or change passwords.

## Apply to your current deployment

1. Extract this ZIP.
2. Replace these files in your existing GitHub repository:

```text
public/app.js
public/index.html
```

3. Commit/push and deploy the latest commit in your existing Render service. You can also replace the repository with the complete project-folder contents.
4. Wait for the deployment to finish, then open the dashboard and press **Ctrl+Shift+R**.
5. Sign in using your existing Supabase email/password.
6. Check that the workspace opens. Then sign out and sign in once more.

Keep your current Supabase project, accounts, database tables and Render settings. No SQL migration or new environment variable is required. `index.html` includes a new script version so browsers request the corrected `app.js`.

If you were already authenticated before redeployment, the saved session should restore the workspace automatically. A single normal reload may also recover the old version when the only issue is a missed login notification; the new package removes that dependency.

## Verification performed

The regression suite first failed against the uploaded implementation for the reported scenario: a valid login response without an auth notification left the screen blocked. It passes after the fix.

Checks include:

- Fresh login with no `SIGNED_IN` notification.
- Explicit sign-out with no `SIGNED_OUT` notification, followed by another login.
- Saved-session restore, remote sign-in/out and repeated null session events.
- Token refresh without restarting fleet discovery.
- Invalid credentials and authentication network failures.
- Slow/failed fleet loading and logout during an in-flight load.
- Map initialization failure while login remains functional.
- The actual Supabase JavaScript SDK with mocked Auth HTTP responses (including `/token` and `/logout`).

The existing interface/monitoring suite also passes, including both themes, navigation, search, replay, braking injection, model switching, API configuration and the measurement update fallback.

These are local DOM/SDK tests. They do not contact your Supabase account or deployed Render service. The visual preview is a separate offline design demonstration; deploy the project to test actual login.

## Optional local regression checks

Development dependencies:

```sh
npm install --no-save --package-lock=false jsdom@26.1.0 @supabase/supabase-js@2
node scripts/test_auth_flow.cjs
```

The monitoring tests and fixture-generation instructions remain in `MEASUREMENTS_FIX.md`.

## Auth implementation references

- [Supabase password sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithpassword)
- [Supabase auth state notifications](https://supabase.com/docs/reference/javascript/auth-onauthstatechange)
- [Supabase guidance on API calls in auth callbacks](https://supabase.com/docs/guides/troubleshooting/why-is-my-supabase-api-call-not-returning-PGzXw0)
