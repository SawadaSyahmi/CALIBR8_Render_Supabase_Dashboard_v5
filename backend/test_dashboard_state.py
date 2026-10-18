"""Regression checks for HTTP-driven dashboard updates (no live Supabase needed).

Run from the project root: python -m unittest discover -s backend -p test_dashboard_state.py -v
The actual physics engine, saved ML models, API handlers and store methods run;
only the Supabase REST transport and the external customer's feed are substituted.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app import main
from app.store import SupabaseStore


class MemoryTransportStore(SupabaseStore):
    def __init__(self):
        self.tables = {}
        self.queries = []

    def _request(self, method, table, *, params=None, body=None, prefer=None):
        params = params or {}
        self.queries.append((method, table, deepcopy(params)))
        rows = self.tables.setdefault(table, [])
        if method == 'POST':
            keys = params.get('on_conflict', '').split(',')
            existing = next((r for r in rows if keys != [''] and all(r.get(k) == body.get(k) for k in keys)), None)
            if existing is None:
                rows.append(deepcopy(body))
            else:
                existing.update(deepcopy(body))
            return [deepcopy(body)]
        selected = [r for r in rows if all(not str(v).startswith('eq.') or str(r.get(k)) == str(v)[3:] for k, v in params.items())]
        if method == 'GET':
            for clause in reversed(params.get('order', '').split(',')):
                if clause:
                    col, _, direction = clause.partition('.')
                    selected.sort(key=lambda r: str(r.get(col, '')), reverse=direction == 'desc')
            return deepcopy(selected[:int(params.get('limit', len(selected)))])
        if method == 'DELETE':
            self.tables[table] = [r for r in rows if r not in selected]
            return None
        raise AssertionError(method)


class DashboardStateTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryTransportStore()
        self.original_store = main.store
        main.store = self.store
        main.app.dependency_overrides[main.dashboard_auth] = lambda: {'uid': 'test-user', 'email': 'test@example.com'}
        self.client = TestClient(main.app)
        self.saved = {}

    def tearDown(self):
        target = os.getenv('CALIBR8_TEST_FIXTURES')
        if target and self.saved:
            path = Path(target)
            path.parent.mkdir(parents=True, exist_ok=True)
            prior = json.loads(path.read_text()) if path.exists() else {}
            prior.update(self.saved)
            path.write_text(json.dumps(prior, indent=2))
        main.store = self.original_store
        main.app.dependency_overrides.clear()
        self.client.close()

    def post(self, path, body=None):
        response = self.client.post(path, json=body or {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_replay_response_supplies_all_measurements_without_realtime(self):
        self.store.set_live('main', 'demo_vehicle', 'replay', {'route_1_normal': 9})
        first = self.post('/api/replay/tick')
        second = self.post('/api/replay/tick')
        self.assertGreater(second['gps']['speed_kmh'], 0)
        self.assertEqual(second['gps']['speed_kmh'], second['raw_api_output']['speed'])
        self.assertIn('peak_deceleration_mps2', second['telemetry'])
        self.assertGreater(second['physics']['a_available_mps2'], 0)
        self.assertGreater(second['trip']['distance_km'], 0)
        self.assertEqual(second['trip']['route_points'], 2)
        self.assertNotEqual(first['route_point']['id'], second['route_point']['id'])
        snap = self.client.get('/api/state?vehicle_id=demo_vehicle').json()
        self.assertEqual(len(snap['route_points']), 2)
        self.assertEqual(snap['live']['telemetry'], second['telemetry'])
        self.assertNotIn('api_connections', snap['live'])
        self.saved.update(normal=second, normal_snapshot=snap)

    def test_injected_harsh_event_populates_physics_models_and_history(self):
        out = self.post('/api/replay/inject')
        self.assertEqual(out['telemetry']['peak_deceleration_mps2'], -6.5)
        self.assertEqual(out['telemetry']['max_jerk_mps3'], -13)
        self.assertGreater(out['physics']['utilisation'], 0.6)
        self.assertTrue(out['inference']['harsh_or_severe'])
        self.assertGreater(out['inference']['probability_harsh'], 0.9)
        self.assertEqual(out['trip']['harsh_events'], 1)
        self.assertIn('event_id', out['event'])
        snapshot = self.client.get('/api/state?vehicle_id=demo_vehicle').json()
        self.assertEqual(len(snapshot['events']), 1)
        again = self.post('/api/inference')
        self.assertEqual(again['trip']['harsh_events'], 1)
        friend = self.post('/api/inference', {'model': 'friend_gbm'})
        self.assertIn('Friend GBM', friend['inference']['model'])
        self.assertTrue(friend['inference']['harsh_or_severe'])
        self.saved.update(harsh=out, harsh_snapshot=snapshot, friend=friend)

    def test_fleet_live_api_response_supplies_the_same_dashboard_contract(self):
        conn = self.store.save_connection('main', 'test-conn', {'name': 'Test fleet', 'url': 'https://example.com/vehicles', 'enabled': True})
        raw = [
            {'deviceId': 'CAR-1', 'dateTime': 1792298800, 'latitude': 3.0, 'longitude': 101.0, 'speed': 50},
            {'deviceId': 'CAR-1', 'dateTime': 1792298802, 'latitude': 3.0001, 'longitude': 101.0001, 'speed': 32},
        ]
        async def feed(_):
            return raw, {'ok': True, 'latency_ms': 1.5}
        with patch.object(main, 'fetch_connection', feed):
            out = self.post('/api/monitor/tick', {'connection_id': conn['connection_id'], 'external_vehicle_id': 'CAR-1'})
        self.assertEqual(out['gps']['speed_kmh'], 32)
        self.assertEqual(out['telemetry']['pre_event_speed_kmh'], 50)
        self.assertAlmostEqual(out['telemetry']['peak_deceleration_mps2'], -2.875)
        self.assertEqual(out['trip']['route_points'], 1)
        self.assertIn('mu_est', out['physics'])
        self.saved['fleet'] = out

    def test_empty_state_and_trip_reset_are_readable(self):
        empty = self.client.get('/api/state?vehicle_id=empty').json()
        self.assertEqual(empty['live'], {})
        self.assertEqual(empty['route_points'], [])
        self.post('/api/replay/inject')
        self.post('/api/replay/reset')
        snap = self.client.get('/api/state?vehicle_id=demo_vehicle').json()
        self.assertEqual(snap['live']['trip']['distance_km'], 0)
        self.assertEqual(snap['live']['trip']['harsh_events'], 0)
        self.assertEqual(snap['route_points'], [])
        self.assertEqual(snap['events'], [])
        self.saved['reset_snapshot'] = snap

    def test_snapshot_requires_login(self):
        main.app.dependency_overrides.clear()
        self.assertEqual(self.client.get('/api/state').status_code, 401)

    def test_vehicle_histories_and_event_ids_are_isolated(self):
        one = self.post('/api/replay/inject', {'vehicle_id': 'car-one'})
        two = self.post('/api/replay/inject', {'vehicle_id': 'car-two'})
        self.assertNotEqual(one['trip']['active_trip_id'], two['trip']['active_trip_id'])
        self.assertNotEqual(one['event']['event_id'], two['event']['event_id'])
        snapshot = self.client.get('/api/state?vehicle_id=car-two').json()
        self.assertEqual(len(snapshot['events']), 1)
        for point in snapshot['route_points']:
            self.assertEqual(point['trip_id'], two['trip']['active_trip_id'])
        for method, table, params in self.store.queries:
            if method == 'GET' and table in {'events', 'route_points'} and 'trip_id' in params:
                self.assertIn('vehicle_id', params)


if __name__ == '__main__':
    unittest.main()
