# Deploy the complete CALIBR8 project

For an existing deployment, follow `START_HERE.md`. This page covers a new deployment.

## Supabase

1. Create a Supabase project and run `supabase_schema.sql` in SQL Editor.
2. Enable Email/Password authentication. Create the authorized user manually, with email confirmed as appropriate for your workspace.
3. Disable public sign-up; all authenticated users share this one organization's data.
4. Copy the project URL and publishable key. An existing anon key is also accepted.

## Encryption key

Generate a Fernet key locally if this is a new deployment:

```sh
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Keep it as `CONNECTION_ENCRYPTION_KEY` on Render. If upgrading, retain your existing key.

## Render

Push this complete project folder's contents to GitHub. The repository root should contain `render.yaml`, `public`, `backend` and `supabase_schema.sql`.

Use the included Blueprint or set up a Python Web Service with:

| Setting       | Value                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Python        | 3.12.14                                                                                              |
| Build command | `pip install --upgrade pip && pip install -r backend/requirements.txt`                               |
| Start command | `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips '*'` |
| Health check  | `/api/health`                                                                                        |

Environment variables:

| Variable                    | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `SUPABASE_URL`              | Existing project URL                                       |
| `SUPABASE_PUBLISHABLE_KEY`  | Publishable key; `SUPABASE_ANON_KEY` is also accepted      |
| `CONNECTION_ENCRYPTION_KEY` | Encrypt saved customer API headers                         |
| `INGEST_API_KEY`            | Additional key for device uploads; Blueprint generates one |
| `ALLOW_DEMO`                | `true` to enable replay and public sample APIs             |
| `OMP_NUM_THREADS`           | `1`                                                        |
| `OPENBLAS_NUM_THREADS`      | `1`                                                        |
| `MKL_NUM_THREADS`           | `1`                                                        |
| `NUMEXPR_NUM_THREADS`       | `1`                                                        |

The application does not require a service-role key. Frontend assets and API routes run on the same service, with no separate frontend build or hosting step.

After deployment, sign in using the account created in Supabase, run the sample, and use **Workspace settings → Check connection**. If the database check fails, rerun the included SQL migration and confirm the environment variables.

The first request to an idle service may take time to start. The UI provides request timeouts and retry instead of leaving playback in a running state after a failed request.

## Local run

Install `backend/requirements.txt`, fill `backend/.env`, then run:

```sh
uvicorn backend.app.main:app --env-file backend/.env --reload
```

Use `http://127.0.0.1:8000`. Cookie security uses the request's HTTPS scheme in deployment and supports HTTP localhost during development.
