"""Explicit per-request credentials and one atomic write for a live frame."""
from __future__ import annotations

from typing import Any
import httpx
from fastapi import HTTPException
from .config import settings


class Repository:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def request(self, token, method, table, *, params=None, body=None, prefer=None):
        headers = {'apikey': settings.supabase_publishable_key, 'Authorization': 'Bearer ' + token}
        if prefer:
            headers['Prefer'] = prefer
        try:
            result = await self.client.request(method, settings.supabase_url + '/rest/v1/' + table, params=params, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise HTTPException(503, 'The database is temporarily unavailable. Your current readings remain visible.') from exc
        if result.status_code >= 400:
            if result.status_code == 401:
                raise HTTPException(401, 'Your session expired. Please sign in again.')
            raise HTTPException(503, 'Database access failed. Run the included supabase_schema.sql and check your Supabase permissions.')
        return result.json() if result.content else None

    async def rows(self, token, table, **filters):
        return await self.request(token, 'GET', table, params={'select': '*', **filters}) or []

    async def upsert(self, token, table, body, conflict):
        return await self.request(token, 'POST', table, params={'on_conflict': conflict}, body=body,
                                  prefer='resolution=merge-duplicates,return=representation')

    async def connections(self, token):
        rows = await self.rows(token, 'api_connections', order='updated_at.desc')
        return [{**r['data'], 'connection_id': r['connection_id']} for r in rows]

    async def connection(self, token, key):
        rows = await self.rows(token, 'api_connections', connection_id='eq.' + key, limit=1)
        if not rows:
            raise HTTPException(404, 'This API connection no longer exists. Refresh the connection list.')
        return {**rows[0]['data'], 'connection_id': key}

    async def frame(self, token, vehicle_id):
        rows = await self.rows(token, 'live_state', vehicle_id='eq.' + vehicle_id, kind='eq.inference', limit=1)
        value = rows[0]['data'] if rows else None
        return value if value and value.get('schema_version') == 7 else None

    async def history(self, token, vehicle_id, trip_id):
        import asyncio
        route, events = await asyncio.gather(
            self.rows(token, 'route_points', vehicle_id='eq.' + vehicle_id, trip_id='eq.' + trip_id, order='server_updated_at.desc', limit=500),
            self.rows(token, 'events', vehicle_id='eq.' + vehicle_id, trip_id='eq.' + trip_id, order='timestamp.desc', limit=1000),
        )
        return {'route': [{**r['data'], 'id': r['id'], 'trip_id': r['trip_id']} for r in reversed(route)],
                'events': [{**r['data'], 'event_id': r['event_id'], 'trip_id': r['trip_id']} for r in events]}

    async def commit(self, token, frame):
        return await self.request(token, 'POST', 'rpc/calibr8_commit_frame', body={'p_vehicle_id': frame['vehicle_id'], 'p_frame': frame})

    async def reset(self, token, vehicle_id):
        return await self.request(token, 'POST', 'rpc/calibr8_reset_vehicle', body={'p_vehicle_id': vehicle_id})
