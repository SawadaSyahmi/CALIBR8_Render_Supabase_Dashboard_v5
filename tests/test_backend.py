"""API tests use real trained models and a mock of Supabase's HTTP boundary."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.auth import SupabaseGateway
from backend.app.config import settings
from backend.app.connections import latest_by_vehicle, normalize_record, telemetry_from_points
from backend.app.repository import Repository


class SupabaseTransport:
    def __init__(self):
        self.connections = {}
        self.frames = {}
        self.points = {}
        self.events = {}
        self.expired = False
        self.storage_down = False
        self.auth_down = False
        self.requests = []

    def __call__(self, request):
        self.requests.append((request.method, request.url.path, request.headers.get('authorization')))
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if path.startswith('/auth/v1/'):
            if self.auth_down:
                return httpx.Response(503, json={'msg': 'Unavailable'})
            if path.endswith('/token'):
                if request.url.params.get('grant_type') == 'refresh_token':
                    if body.get('refresh_token') != 'refresh-test':
                        return httpx.Response(400, json={'msg': 'Invalid refresh token'})
                    self.expired = False
                elif body.get('password') != 'test-password':
                    return httpx.Response(400, json={'msg': 'Invalid login credentials'})
                return httpx.Response(200, json={'access_token': 'access-test', 'refresh_token': 'refresh-test', 'expires_in': 3600,
                    'user': {'id': 'member-test', 'email': 'member@example.com'}})
            if path.endswith('/user'):
                if request.headers.get('authorization') != 'Bearer access-test' or self.expired:
                    return httpx.Response(401, json={'msg': 'Token expired'})
                return httpx.Response(200, json={'id': 'member-test', 'email': 'member@example.com'})
            return httpx.Response(204)
        if request.headers.get('authorization') != 'Bearer access-test':
            return httpx.Response(401, json={'message': 'Missing user token'})
        if self.storage_down:
            return httpx.Response(503, json={'message': 'Storage unavailable'})
        if path.endswith('/api_connections'):
            key = request.url.params.get('connection_id', '')[3:]
            if request.method == 'GET':
                return httpx.Response(200, json=[self.connections[key]] if key in self.connections else [] if key else list(self.connections.values()))
            if request.method == 'DELETE':
                self.connections.pop(key, None)
                return httpx.Response(204)
            self.connections[body['connection_id']] = body
            return httpx.Response(200, json=[body])
        if path.endswith('/live_state'):
            key = request.url.params.get('vehicle_id', '')[3:]
            value = self.frames.get(key)
            return httpx.Response(200, json=[{'vehicle_id': key, 'kind': 'inference', 'data': value}] if value else [])
        if path.endswith('/calibr8_schema_version'):
            return httpx.Response(200, json=7)
        if path.endswith('/calibr8_reset_vehicle'):
            self.frames.pop(body['p_vehicle_id'], None)
            return httpx.Response(200, json={'active_trip_id': 'new-trip'})
        if path.endswith('/calibr8_commit_frame'):
            frame = body['p_frame']
            key = body['p_vehicle_id']
            trip = copy.deepcopy(self.frames.get(key, {}).get('trip', {'active_trip_id': 'trip-test', 'distance_km': .02, 'harsh_events': 0, 'route_points': 0}))
            point = {**frame['route_point'], 'trip_id': trip['active_trip_id']}
            if point['id'] not in self.points:
                self.points[point['id']] = {'id': point['id'], 'data': point, 'vehicle_id': key, 'trip_id': trip['active_trip_id']}
                trip['route_points'] += 1
            event = frame.get('event')
            if event:
                event['trip_id'] = trip['active_trip_id']
                if event['event_id'] not in self.events:
                    trip['harsh_events'] += 1
                self.events[event['event_id']] = {'event_id': event['event_id'], 'data': event, 'vehicle_id': key, 'trip_id': trip['active_trip_id']}
            self.frames[key] = {**frame, 'route_point': point, 'event': event, 'trip': trip}
            return httpx.Response(200, json=self.frames[key])
        if path.endswith(('/route_points', '/events')):
            source = self.events if path.endswith('/events') else self.points
            key = request.url.params.get('vehicle_id', '')[3:]
            return httpx.Response(200, json=[row for row in source.values() if row['vehicle_id'] == key])
        return httpx.Response(404, json={'message': path})


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved = settings.__dict__.copy()
        settings.supabase_url = 'https://supabase.test'
        settings.supabase_publishable_key = 'public-test-key'
        settings.connection_encryption_key = Fernet.generate_key().decode()
        settings.ingest_api_key = 'ingest-test-key'
        cls.client = TestClient(main.app, base_url='https://dashboard.test')
        cls.client.__enter__()
        cls.transport = SupabaseTransport()
        cls.external = httpx.AsyncClient(transport=httpx.MockTransport(cls.transport))
        main.app.state.gateway = SupabaseGateway(cls.external)
        main.app.state.repository = Repository(cls.external)
        cls.fixtures = {}

    @classmethod
    def tearDownClass(cls):
        target = os.getenv('CALIBR8_TEST_FIXTURES')
        if target:
            Path(target).write_text(json.dumps(cls.fixtures, indent=2))
        cls.client.portal.call(cls.external.aclose)
        cls.client.__exit__(None, None, None)
        settings.__dict__.clear()
        settings.__dict__.update(cls.saved)

    def setUp(self):
        self.transport.expired = self.transport.storage_down = self.transport.auth_down = False
        self.client.cookies.clear()
        result = self.client.post('/api/auth/login', json={'email': 'member@example.com', 'password': 'test-password'})
        self.assertEqual(result.status_code, 200, result.text)

    def step(self, **patches):
        return self.client.post('/api/replay/step', json={'run_id': 'test-run', 'scenario': 'route_1', 'index': 10, **patches})

    def test_auth_cookie_restore_refresh_and_logout(self):
        self.assertEqual(self.client.get('/api/auth/session').status_code, 200)
        self.transport.expired = True
        self.assertEqual(self.client.get('/api/auth/session').status_code, 401)
        result = self.client.post('/api/auth/refresh')
        self.assertEqual(result.status_code, 200)
        self.assertIn('HttpOnly', result.headers['set-cookie'])
        self.assertIn('Secure', result.headers['set-cookie'])
        self.assertEqual(self.client.get('/api/auth/session').status_code, 200)
        self.assertEqual(self.client.post('/api/auth/logout').status_code, 200)
        self.assertEqual(self.client.get('/api/auth/session').status_code, 401)
        self.assertEqual(self.step().status_code, 401)

    def test_static_modules_and_cache_policy(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('/js/app.js?v=7.0.0', response.text)
        self.assertNotIn('cdn.jsdelivr.net', response.text)
        self.assertIn('no-store', response.headers['cache-control'])
        for filename in (Path(__file__).resolve().parent.parent / 'public/js').glob('*.js'):
            response = self.client.get('/js/' + filename.name)
            self.assertEqual(response.status_code, 200)
            self.assertIn('javascript', response.headers['content-type'])
        self.assertEqual(self.client.get('/theme-tokens.css').status_code, 200)

    def test_bad_login_network_failure_and_csrf(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.post('/api/auth/login', json={'email':'member@example.com','password':'wrong'}).status_code, 401)
        self.transport.auth_down = True
        self.assertEqual(self.client.post('/api/auth/login', json={'email':'member@example.com','password':'test-password'}).status_code, 503)
        self.assertEqual(self.client.post('/api/auth/login', headers={'Origin':'https://other.test'}, json={'email':'a@b.com','password':'test-password'}).status_code, 403)

    def test_sample_does_not_depend_on_database(self):
        self.transport.storage_down = True
        before = len(self.transport.requests)
        result = self.step()
        self.assertEqual(result.status_code, 200, result.text)
        frame = result.json()
        self.assertEqual(frame['schema_version'], 7)
        self.assertNotEqual(frame['telemetry']['peak_deceleration_mps2'], 0)
        self.assertGreater(frame['physics']['a_available_mps2'], 0)
        self.assertGreater(frame['trip']['distance_km'], 0)
        self.assertEqual(set(frame['models']), {'new_ai','friend_gbm'})
        self.assertFalse(any('/rest/v1/' in path for _,path,_ in self.transport.requests[before:]))
        self.fixtures['normal'] = frame

    def test_harsh_both_models_and_re_evaluation(self):
        frame = self.step(inject=True).json()
        self.assertTrue(frame['models']['new_ai']['harsh_or_severe'])
        self.assertTrue(frame['models']['friend_gbm']['harsh_or_severe'])
        self.assertEqual(frame['telemetry']['peak_deceleration_mps2'], -6.5)
        self.assertEqual(frame['telemetry']['max_jerk_mps3'], -13)
        result = self.client.post('/api/evaluate', json={key:frame[key] for key in ['telemetry','gps','context']}|{'model':'friend_gbm','mode':'safety'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIn('Friend', result.json()['decision']['model'])
        self.fixtures['harsh'] = frame

    def test_synthetic_has_consistent_speed_and_distance(self):
        result = self.client.post('/api/synthetic/step', json={'run_id':'synthetic-test','index':10})
        self.assertEqual(result.status_code,200,result.text)
        frame = result.json()
        self.assertEqual(frame['gps']['speed_kmh'],frame['telemetry']['post_event_speed_kmh'])
        self.assertGreater(frame['trip']['distance_km'],0)

    def test_routes_completion_repeatability_validation(self):
        for route in ['route_1','route_2','route_3']:
            frame = self.step(scenario=route, index=999999).json()
            self.assertTrue(frame['complete'])
            self.assertEqual(frame['replay']['index'], frame['replay']['totalPoints']-1)
        first, second = self.step().json(), self.step().json()
        self.assertEqual(first['frame_id'], second['frame_id'])
        self.assertEqual(self.step(scenario='unknown').status_code, 422)
        self.assertEqual(self.step(index=-1).status_code, 422)
        self.assertEqual(self.step(model='unknown').status_code, 422)
        self.assertEqual(self.client.get('/api/mock/live?scenario=route_1&index=3').status_code,200)
        settings.allow_demo = False
        try:self.assertEqual(self.step().status_code,403)
        finally:settings.allow_demo = True

    def test_connections_live_measurements_and_save_failure(self):
        result = self.client.post('/api/connections',json={'name':'Fleet test','url':'https://fleet.example.com/data','headers':{'Authorization':'Bearer private-test'},'default_context':{'road_surface':'wet_asphalt','weather':'light_rain'}})
        self.assertEqual(result.status_code,200,result.text)
        connection = result.json()['connection']
        self.assertTrue(connection['has_headers'])
        self.assertNotIn('headers_encrypted',connection)
        stored = self.transport.connections[connection['connection_id']]['data']
        self.assertNotIn('private-test',stored['headers_encrypted'])
        rows = [{'deviceId':'CAR-1','dateTime':1770000000,'latitude':3.1,'longitude':101.6,'speed':50},
                {'deviceId':'CAR-1','dateTime':1770000002,'latitude':3.1001,'longitude':101.6001,'speed':32}]
        async def fetch(_):return rows, {'ok':True,'latency_ms':4}
        with patch.object(main,'fetch_connection',fetch):
            discovered = self.client.post('/api/fleet/discover').json()
            self.assertTrue(discovered['vehicles'])
            value={'connection_id':connection['connection_id'],'external_vehicle_id':'CAR-1'}
            response = self.client.post('/api/monitor/tick',json=value)
            self.assertEqual(response.status_code,200,response.text)
            frame=response.json()
            self.assertEqual(frame['gps']['speed_kmh'],32)
            self.assertAlmostEqual(frame['telemetry']['peak_deceleration_mps2'],-2.875)
            self.assertTrue(frame['persistence']['saved'])
            self.assertIn('GPS',frame['quality']['note'])
            again=self.client.post('/api/monitor/tick',json=value).json()
            self.assertTrue(again['fleet_api']['stale'])
            self.assertEqual(again['trip']['route_points'],frame['trip']['route_points'])
            self.fixtures['fleet']=frame
            self.fixtures['vehicle']=discovered['vehicles'][0]
            self.fixtures['connection']=connection
            self.fixtures['live_state']=self.client.get('/api/state',params={'vehicle_id':frame['vehicle_id']}).json()
            original_commit=main.app.state.repository.commit
            async def fail(*_):raise main.HTTPException(503,'Storage is down')
            with patch.object(main.app.state.repository,'commit',fail):
                failed=self.client.post('/api/monitor/tick',json=value)
                self.assertEqual(failed.status_code,200)
                self.assertFalse(failed.json()['persistence']['saved'])
                self.assertEqual(failed.json()['gps']['speed_kmh'],32)

    def test_device_ingest_and_diagnostics(self):
        frame=self.step(inject=True).json()
        body={key:frame[key] for key in ['telemetry','gps','context']}|{'vehicle_id':'sensor_1'}
        self.assertEqual(self.client.post('/api/ingest',json=body).status_code,401)
        response=self.client.post('/api/ingest',json=body,headers={'X-CALIBR8-INGEST-KEY':'ingest-test-key'})
        self.assertEqual(response.status_code,200,response.text)
        state=self.client.get('/api/state?vehicle_id=sensor_1').json()
        self.assertTrue(state['frame']['decision']['harsh_or_severe'])
        self.assertEqual(len(state['history']['events']),1)
        self.assertTrue(self.client.get('/api/diagnostics').json()['ok'])
        body['gps']['timestamp'] = 'not-a-date'
        self.assertEqual(self.client.post('/api/ingest',json=body,headers={'X-CALIBR8-INGEST-KEY':'ingest-test-key'}).status_code,422)

    def test_gps_mapping_and_long_intervals_are_not_fabricated(self):
        self.assertIsNone(normalize_record({'deviceId':'bad','latitude':3,'longitude':101,'dateTime':'bad','speed':40},{}))
        self.assertIsNone(normalize_record({'deviceId':'bad','latitude':3,'longitude':101,'dateTime':1},{}))
        current={'speed_kmh':36,'timestamp_epoch':120,'timestamp':'2026-01-01T00:02:00Z'}
        previous={'speed_kmh':72,'timestamp_epoch':0}
        self.assertAlmostEqual(telemetry_from_points(current,previous)['mean_deceleration_mps2'],-10/120)


if __name__=='__main__':unittest.main(verbosity=2)
