from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import csv
import hashlib
import hmac
import io
import logging
import re
import time
import uuid
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .auth import (Identity, SupabaseGateway, require_user, public_user, write_session, clear_session, ACCESS_COOKIE, REFRESH_COOKIE)
from .config import settings, PUBLIC_DIR
from .connections import (DEFAULT_MAPPING, build_context, encrypt_headers, fetch_connection, latest_by_vehicle,
                          public_connection, telemetry_from_points, validate_external_url)
from .demo import demo_payload, DEMO_PATH
from .engine import evaluate, make_frame, now, replay_frame, distance_km
from .models import ModelHub
from .repository import Repository
from .replay import SCENARIOS, build_replay_payload, list_scenarios, load_route
from .schemas import (LoginInput, ReplayInput, SyntheticInput, EvaluateInput, ConnectionInput,
                      MonitorInput, VehicleInput, IngestInput, Telemetry, GPSPoint, Context)
from .sources import read_external

log = logging.getLogger('calibr8')


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=8)) as client:
        app.state.gateway = SupabaseGateway(client)
        app.state.repository = Repository(client)
        app.state.model_lock = asyncio.Semaphore(1)
        app.state.models = await run_in_threadpool(ModelHub)
        yield


app = FastAPI(title='CALIBR8 Fleet Intelligence', version='7.0.0', lifespan=lifespan)


@app.middleware('http')
async def response_policy(request, call_next):
    if request.url.path.startswith('/api/') and request.method not in {'GET', 'HEAD', 'OPTIONS'}:
        origin = request.headers.get('origin')
        if origin:
            parsed = urlparse(origin)
            if parsed.netloc != request.headers.get('host') or parsed.scheme != request.url.scheme:
                return JSONResponse({'detail': 'Cross-site requests are not allowed.'}, status_code=403)
        if request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'detail': 'Cross-site requests are not allowed.'}, status_code=403)
    try:
        result = await call_next(request)
    except Exception:
        log.exception('Unhandled request failure: %s', request.url.path)
        result = JSONResponse({'detail': 'The request could not finish. Your last readings are still available. Try again.'}, status_code=500)
    if request.url.path.startswith('/api/') or request.url.path in {'/', '/index.html'} or request.url.path.endswith(('.js', '.css')):
        result.headers['Cache-Control'] = 'private, no-store'
    result.headers['X-Content-Type-Options'] = 'nosniff'
    result.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    return result


async def compute(request, fn, *args, **kwargs):
    async with request.app.state.model_lock:
        return await run_in_threadpool(fn, request.app.state.models, *args, **kwargs)


def repo(request):
    return request.app.state.repository


def demos_enabled():
    if not settings.allow_demo:
        raise HTTPException(403, 'Sample playback is disabled by the server administrator.')


@app.get('/api/health')
def health():
    return {'ok': True, 'version': '7.0.0', 'auth_configured': settings.configured,
            'demo_enabled': settings.allow_demo, 'legacy_enabled': bool(settings.telemetry_api_url and settings.gps_api_url and settings.context_api_url),
            'models': ['new_ai', 'friend_gbm']}


@app.post('/api/auth/login')
async def login(value: LoginInput, request: Request, response: Response):
    session = await request.app.state.gateway.auth('POST', 'token', params={'grant_type': 'password'}, body={'email': value.email.strip(), 'password': value.password})
    write_session(response, request, session)
    return {'user': public_user(session['user'])}


@app.post('/api/auth/refresh')
async def refresh(request: Request, response: Response):
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(401, 'Please sign in again.')
    session = await request.app.state.gateway.auth('POST', 'token', params={'grant_type': 'refresh_token'}, body={'refresh_token': token})
    write_session(response, request, session)
    return {'user': public_user(session['user'])}


@app.get('/api/auth/session')
async def session(identity: Identity = Depends(require_user)):
    return {'user': {'id': identity.user_id, 'email': identity.email}}


@app.get('/api/diagnostics')
async def diagnostics(request: Request, identity=Depends(require_user)):
    await repo(request).rows(identity.token, 'api_connections', limit=1)
    version = await repo(request).request(identity.token, 'POST', 'rpc/calibr8_schema_version', body={})
    return {'ok': version == 7, 'message': 'Authentication and database access are working. Database functions are up to date.' if version == 7 else 'Run the included supabase_schema.sql to update the database functions.'}


@app.post('/api/auth/logout')
async def logout(request: Request, response: Response):
    token = request.cookies.get(ACCESS_COOKIE)
    try:
        if token:
            await request.app.state.gateway.auth('POST', 'logout', token=token, params={'scope': 'local'})
    except HTTPException:
        pass
    clear_session(response)
    return {'ok': True}


@app.get('/api/replay/scenarios')
def scenarios():
    demos_enabled()
    return {'scenarios': list_scenarios()}


@app.post('/api/replay/step')
async def replay(value: ReplayInput, request: Request, identity=Depends(require_user)):
    demos_enabled()
    return await compute(request, replay_frame, value)


@app.post('/api/synthetic/step')
async def synthetic(value: SyntheticInput, request: Request, identity=Depends(require_user)):
    demos_enabled()
    t, g, c = demo_payload(value.index)
    g['speed_kmh'] = t['post_event_speed_kmh']
    frame = await compute(request, make_frame, t, g, c, vehicle_id='synthetic_vehicle', source='synthetic',
                          identity=value.run_id + ':' + str(value.index), model=value.model, mode=value.mode,
                          raw={'telemetry': t, 'gps': g, 'context': c})
    prefix = [0.0]
    for a, b in zip(DEMO_PATH, DEMO_PATH[1:]):
        prefix.append(prefix[-1] + distance_km({'lat': a[0], 'lon': a[1]}, {'lat': b[0], 'lon': b[1]}))
    distance = (value.index // len(DEMO_PATH)) * prefix[-1] + prefix[value.index % len(DEMO_PATH)]
    frame.update(run_id=value.run_id, complete=False, replay={'index': value.index, 'totalPoints': None, 'sourceDeltaSec': 1, 'scenarioName': 'Synthetic drive'},
                 trip={'active_trip_id': value.run_id, 'distance_km': distance, 'route_points': value.index + 1})
    return frame


@app.post('/api/evaluate')
async def evaluate_current(value: EvaluateInput, request: Request, identity=Depends(require_user)):
    return await compute(request, evaluate, value.telemetry.model_dump(), value.gps.model_dump(), value.context.model_dump(), value.model, value.mode)


@app.get('/api/mock/live')
def rotating_sample(scenario: str = 'route_1', harsh: bool = False, index: int | None = Query(default=None, ge=0)):
    demos_enabled()
    if scenario not in SCENARIOS:
        raise HTTPException(400, 'Choose route_1, route_2 or route_3.')
    step = index if index is not None else int(time.time() // 5) % len(load_route(scenario))
    pack = build_replay_payload(scenario, step, harsh_demo=harsh)
    pack['raw_api_output']['dateTime'] = int(time.time() // 5) * 5
    return [pack['raw_api_output']]


@app.get('/api/mock/harsh-event')
def mock_harsh(scenario: str = 'route_1'):
    demos_enabled()
    if scenario not in SCENARIOS:
        raise HTTPException(400, 'Unknown sample route.')
    return [build_replay_payload(scenario, 10, force_harsh=True)['raw_api_output']]


@app.get('/api/connections')
async def connections(request: Request, identity=Depends(require_user)):
    return {'connections': [public_connection(c) for c in await repo(request).connections(identity.token)]}


@app.post('/api/connections')
async def save_connection(value: ConnectionInput, request: Request, identity=Depends(require_user)):
    try:
        url = validate_external_url(value.url)
        old = await repo(request).connection(identity.token, value.connection_id) if value.connection_id else {}
        encrypted = old.get('headers_encrypted', '') if value.headers is None else encrypt_headers(value.headers)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    key = value.connection_id or uuid.uuid4().hex[:16]
    doc = {**value.model_dump(exclude={'headers'}), 'url': url, 'name': value.name.strip(), 'connection_id': key,
           'headers_encrypted': encrypted, 'created_at': old.get('created_at', now()), 'updated_at': now(),
           'field_mapping': {**DEFAULT_MAPPING, **value.field_mapping}}
    if not doc['name']:
        raise HTTPException(400, 'Enter a connection name.')
    await repo(request).upsert(identity.token, 'api_connections', {'connection_id': key, 'data': doc, 'updated_at': doc['updated_at']}, 'connection_id')
    return {'connection': public_connection(doc)}


@app.delete('/api/connections/{connection_id}')
async def delete_connection(connection_id: str, request: Request, identity=Depends(require_user)):
    await repo(request).request(identity.token, 'DELETE', 'api_connections', params={'connection_id': 'eq.' + connection_id})
    return {'ok': True}


def vehicle_key(connection_id, external_id):
    # Preserve v5/v6 vehicle identities so existing trip history stays associated.
    short = re.sub(r'[^A-Za-z0-9_-]', '', connection_id)[:8] or 'api'
    return 'ext_' + short + '_' + hashlib.sha1(external_id.encode()).hexdigest()[:12]


async def discover_connection(connection):
    try:
        payload, status = await fetch_connection(connection)
        groups = latest_by_vehicle(payload, connection) if payload is not None else {}
    except ValueError as exc:
        groups, status = {}, {'ok': False, 'message': str(exc)}
    vehicles = []
    for external_id, points in groups.items():
        current = points[-1]
        vehicles.append({'internal_vehicle_id': vehicle_key(connection['connection_id'], external_id),
                         'external_vehicle_id': external_id, 'connection_id': connection['connection_id'],
                         'connection_name': connection['name'], 'lat': current['lat'], 'lon': current['lon'],
                         'speed_kmh': current['speed_kmh'], 'source_timestamp': current['timestamp'], 'status': 'available'})
    return {'connection_id': connection['connection_id'], 'name': connection['name'], 'status': status, 'vehicles': vehicles}


@app.post('/api/connections/{connection_id}/test')
async def test_connection(connection_id: str, request: Request, identity=Depends(require_user)):
    return await discover_connection(await repo(request).connection(identity.token, connection_id))


@app.post('/api/fleet/discover')
async def discover(request: Request, identity=Depends(require_user)):
    saved = [c for c in await repo(request).connections(identity.token) if c.get('enabled', True)]
    semaphore = asyncio.Semaphore(3)
    async def one(c):
        async with semaphore:
            return await discover_connection(c)
    results = await asyncio.gather(*(one(c) for c in saved))
    vehicles = [v for result in results for v in result['vehicles']]
    return {'connections': results, 'vehicles': sorted(vehicles, key=lambda v: (v['connection_name'], v['external_vehicle_id']))}


async def persist_frame(repository, token, frame):
    try:
        saved = await repository.commit(token, frame)
        saved['persistence'] = {'saved': True, 'message': 'Saved to Supabase'}
        return saved
    except HTTPException as exc:
        if exc.status_code == 401:
            raise
        frame['persistence'] = {'saved': False, 'message': str(exc.detail)}
        return frame


@app.post('/api/monitor/tick')
async def monitor(value: MonitorInput, request: Request, identity=Depends(require_user)):
    repository = repo(request)
    connection = await repository.connection(identity.token, value.connection_id)
    if not connection.get('enabled', True):
        raise HTTPException(409, 'This API connection is disabled.')
    try:
        payload, status = await fetch_connection(connection)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if payload is None:
        raise HTTPException(502, 'The vehicle API could not be read: ' + status.get('message', 'Request failed.'))
    rows = latest_by_vehicle(payload, connection).get(value.external_vehicle_id)
    if not rows:
        raise HTTPException(404, 'The selected vehicle is missing from this API response. Refresh the fleet or check field mapping.')
    vehicle_id = vehicle_key(value.connection_id, value.external_vehicle_id)
    previous_frame = await repository.frame(identity.token, vehicle_id)
    current = rows[-1]
    previous = rows[-2] if len(rows) > 1 else (previous_frame or {}).get('source_point')
    stale = bool(previous_frame and (previous_frame.get('source_point') or {}).get('timestamp_epoch') == current['timestamp_epoch'])
    if stale:
        t = previous_frame['telemetry']
    else:
        t = telemetry_from_points(current, previous)
    g = {'lat': current['lat'], 'lon': current['lon'], 'speed_kmh': current['speed_kmh'], 'timestamp': current['timestamp'], 'heading_deg': current.get('heading_deg')}
    frame = await compute(request, make_frame, t, g, build_context(connection), vehicle_id=vehicle_id, source='fleet',
                          identity=str(current['timestamp_epoch']), model=value.model, mode=value.mode, raw=current['raw'])
    frame['source_point'] = {k: v for k, v in current.items() if k != 'raw'}
    frame['source_point']['derived_accel_mps2'] = t['mean_deceleration_mps2']
    frame['fleet_api'] = {'connection_id': value.connection_id, 'connection_name': connection['name'], 'external_vehicle_id': value.external_vehicle_id,
                          'stale': stale, 'status': status, 'poll_interval_sec': connection.get('poll_interval_sec', 5)}
    return await persist_frame(repository, identity.token, frame)


@app.get('/api/state')
async def state(request: Request, vehicle_id: str = Query(max_length=100, pattern=r'^[A-Za-z0-9_-]+$'), identity=Depends(require_user)):
    frame = await repo(request).frame(identity.token, vehicle_id)
    trip_id = (frame or {}).get('trip', {}).get('active_trip_id')
    history = await repo(request).history(identity.token, vehicle_id, trip_id) if trip_id else {'route': [], 'events': []}
    return {'frame': frame, 'history': history}


@app.post('/api/vehicle/reset')
async def reset(value: VehicleInput, request: Request, identity=Depends(require_user)):
    return await repo(request).reset(identity.token, value.vehicle_id)


@app.post('/api/ingest')
async def ingest(value: IngestInput, request: Request, identity=Depends(require_user)):
    if settings.ingest_api_key and not hmac.compare_digest(request.headers.get('x-calibr8-ingest-key', ''), settings.ingest_api_key):
        raise HTTPException(401, 'A valid X-CALIBR8-INGEST-KEY is required.')
    t, g, c = value.telemetry.model_dump(), value.gps.model_dump(), value.context.model_dump()
    frame = await compute(request, make_frame, t, g, c, vehicle_id=value.vehicle_id, source='device',
                          identity=t.get('timestamp_start') or g.get('timestamp') or now(), model=value.model, mode=value.mode,
                          raw={'telemetry': t, 'gps': g, 'context': c})
    return await persist_frame(repo(request), identity.token, frame)


@app.post('/api/legacy/tick')
async def legacy(value: VehicleInput, request: Request, identity=Depends(require_user)):
    if not (settings.telemetry_api_url and settings.gps_api_url and settings.context_api_url):
        raise HTTPException(409, 'The three legacy API URLs have not been configured on the server.')
    found, status = await read_external()
    if found is None:
        raise HTTPException(502, 'One or more legacy APIs could not be read.')
    t, g, c = (v.model_dump() for v in found)
    frame = await compute(request, make_frame, t, g, c, vehicle_id=value.vehicle_id, source='legacy',
                          identity=t.get('timestamp_start') or g.get('timestamp') or now(), model=value.model, mode=value.mode,
                          raw={'telemetry': t, 'gps': g, 'context': c})
    return await persist_frame(repo(request), identity.token, frame)


@app.get('/api/export/events.csv')
async def export(request: Request, vehicle_id: str = Query(max_length=100, pattern=r'^[A-Za-z0-9_-]+$'), trip_id: str = Query(max_length=100), identity=Depends(require_user)):
    history = await repo(request).history(identity.token, vehicle_id, trip_id)
    columns = ['timestamp', 'model', 'probability', 'speed_kmh', 'peak_decel_mps2', 'physics_label', 'utilisation', 'lat', 'lon']
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for event in history['events']:
        writer.writerow({key: event.get(key) for key in columns})
    return Response(output.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="calibr8_events.csv"'})


app.mount('/', StaticFiles(directory=str(PUBLIC_DIR), html=True), name='dashboard')
