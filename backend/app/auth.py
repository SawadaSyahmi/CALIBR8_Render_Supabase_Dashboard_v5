from __future__ import annotations
import httpx
from fastapi import Header, HTTPException
from .config import settings

async def dashboard_auth(authorization: str | None = Header(default=None)):
    if settings.allow_unauthenticated_dashboard:
        return {'uid':'public-dashboard','email':'public'}
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Supabase access token required')
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=503, detail='Supabase authentication is not configured')
    token = authorization.split(' ',1)[1].strip()
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                f'{settings.supabase_url}/auth/v1/user',
                headers={'apikey': settings.supabase_anon_key, 'Authorization': f'Bearer {token}'},
            )
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail='Invalid or expired Supabase access token')
        user = r.json()
        return {'uid': user.get('id'), 'email': user.get('email'), **user}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f'Supabase authentication failed: {exc}') from exc

async def ingest_auth(x_calibr8_ingest_key: str | None = Header(default=None)):
    if not settings.ingest_api_key:
        raise HTTPException(status_code=503, detail='INGEST_API_KEY is not configured')
    if x_calibr8_ingest_key != settings.ingest_api_key:
        raise HTTPException(status_code=401, detail='Invalid ingest key')
    return True
