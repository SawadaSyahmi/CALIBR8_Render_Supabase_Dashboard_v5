"""Same-origin cookie sessions; tokens never need to enter browser JavaScript."""
from __future__ import annotations

from dataclasses import dataclass
import httpx
from fastapi import HTTPException, Request, Response
from .config import settings

ACCESS_COOKIE = 'calibr8_access'
REFRESH_COOKIE = 'calibr8_refresh'


class SupabaseGateway:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def auth(self, method, path, *, token=None, body=None, params=None):
        if not settings.configured:
            raise HTTPException(503, 'Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) on the server.')
        headers = {'apikey': settings.supabase_publishable_key}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        try:
            result = await self.client.request(method, settings.supabase_url + '/auth/v1/' + path, headers=headers, json=body, params=params)
        except httpx.HTTPError as exc:
            raise HTTPException(503, 'Supabase authentication is temporarily unavailable. Try again.') from exc
        if result.status_code >= 400:
            try:
                error = result.json()
            except ValueError:
                error = {}
            message = error.get('msg') or error.get('error_description') or error.get('message') or 'Authentication failed.'
            status = 401 if result.status_code in {400, 401, 403} else 503
            if result.status_code == 429:
                status = 429
            raise HTTPException(status, str(message)[:220])
        return result.json() if result.content else {}


@dataclass(frozen=True)
class Identity:
    token: str
    user_id: str
    email: str


def public_user(user):
    return {'id': user['id'], 'email': user.get('email', '')}


def write_session(response: Response, request: Request, session: dict):
    if not session.get('access_token') or not session.get('refresh_token') or not session.get('user', {}).get('id'):
        raise HTTPException(502, 'The authentication server did not return a complete session.')
    secure = request.url.scheme == 'https'
    options = dict(httponly=True, secure=secure, samesite='lax', path='/api')
    response.set_cookie(ACCESS_COOKIE, session['access_token'], max_age=int(session.get('expires_in', 3600)), **options)
    response.set_cookie(REFRESH_COOKIE, session['refresh_token'], max_age=60 * 60 * 24 * 30, **options)


def clear_session(response: Response):
    response.delete_cookie(ACCESS_COOKIE, path='/api')
    response.delete_cookie(REFRESH_COOKIE, path='/api')


async def require_user(request: Request) -> Identity:
    authorization = request.headers.get('authorization', '')
    token = authorization[7:].strip() if authorization.startswith('Bearer ') else request.cookies.get(ACCESS_COOKIE)
    if not token:
        raise HTTPException(401, 'Sign in to continue.')
    user = await request.app.state.gateway.auth('GET', 'user', token=token)
    if not user.get('id'):
        raise HTTPException(401, 'Your session is no longer valid. Sign in again.')
    return Identity(token, user['id'], user.get('email', ''))
