from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'

SCENARIOS = {
    'route_1': {
        'file': 'route_1.json',
        'name': 'Sample Route 1',
        'device_id': '075034653492',
        'context': {
            'vehicle_type': 'passenger_car',
            'road_type': 'urban',
            'traffic_density': 'medium',
            'weather': 'clear',
            'road_surface': 'dry_asphalt',
            'road_grade_ratio': 0.0,
        },
    },
    'route_2': {
        'file': 'route_2.json',
        'name': 'Sample Route 2',
        'device_id': '075034655158',
        'context': {
            'vehicle_type': 'passenger_car',
            'road_type': 'urban',
            'traffic_density': 'high',
            'weather': 'light_rain',
            'road_surface': 'wet_asphalt',
            'road_grade_ratio': 0.0,
        },
    },
    'route_3': {
        'file': 'route_3.json',
        'name': 'Sample Route 3',
        'device_id': '075034664531',
        'context': {
            'vehicle_type': 'van_mpv',
            'road_type': 'arterial',
            'traffic_density': 'medium',
            'weather': 'cloudy',
            'road_surface': 'dry_asphalt',
            'road_grade_ratio': 0.0,
        },
    },
}


@lru_cache(maxsize=None)
def load_route(scenario: str) -> tuple[dict, ...]:
    if scenario not in SCENARIOS:
        raise KeyError(f'Unknown replay scenario: {scenario}')
    path = DATA_DIR / SCENARIOS[scenario]['file']
    with path.open('r', encoding='utf-8') as f:
        rows = json.load(f)
    rows = sorted(rows, key=lambda x: int(x.get('dateTime', 0)))
    return tuple(rows)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _heading(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _harsh_index(rows: tuple[dict, ...]) -> int:
    """Choose an early stable point after the vehicle is already moving at useful speed."""
    if len(rows) < 4:
        return max(1, len(rows) // 2)
    for i in range(min(8, len(rows)-2), len(rows) - 1):
        if float(rows[i - 1].get('speed', 0) or 0) >= 35.0:
            return i
    candidate = max(range(1, len(rows) - 1), key=lambda i: float(rows[i - 1].get('speed', 0) or 0))
    return max(2, min(candidate, len(rows) - 2))


def list_scenarios() -> list[dict]:
    out = []
    for key, cfg in SCENARIOS.items():
        rows = load_route(key)
        out.append({
            'key': key,
            'name': cfg['name'],
            'deviceId': cfg['device_id'],
            'points': len(rows),
            'sourceStart': int(rows[0]['dateTime']),
            'sourceEnd': int(rows[-1]['dateTime']),
            'maxSpeedKmh': max(float(r.get('speed', 0) or 0) for r in rows),
            'harshInjectionIndex': _harsh_index(rows),
        })
    return out


def build_replay_payload(scenario: str, step: int, harsh_demo: bool = False, force_harsh: bool = False) -> dict:
    rows = load_route(scenario)
    if not rows:
        raise ValueError('Replay route is empty')

    idx = int(step) % len(rows)
    cycle = int(step) // len(rows)
    current = dict(rows[idx])
    previous = dict(rows[idx - 1] if idx > 0 else rows[0])

    source_ts = int(current.get('dateTime', 0))
    prev_source_ts = int(previous.get('dateTime', source_ts))
    source_dt = max(1.0, float(source_ts - prev_source_ts)) if idx > 0 else 1.0

    pre_speed = float(previous.get('speed', 0.0) or 0.0)
    post_speed = float(current.get('speed', 0.0) or 0.0)
    dv_mps = (post_speed - pre_speed) / 3.6
    longitudinal_accel = dv_mps / source_dt

    # The dashboard expects a braking-event feature row. During ordinary driving,
    # keep a very small negative peak so the classifiers stay in normal/mild territory.
    peak = longitudinal_accel if longitudinal_accel < -0.15 else -0.15
    duration = min(max(source_dt, 0.8), 8.0)
    drop = max(0.0, pre_speed - post_speed)
    mean = peak * 0.65
    jerk = peak / max(min(duration * 0.35, 1.5), 0.20)

    injection_idx = _harsh_index(rows)
    inject = bool(force_harsh or (harsh_demo and idx == injection_idx))
    harsh_event = None

    if inject:
        # One explicit, reproducible harsh-braking event. It uses the real route
        # location but controlled braking dynamics so both models can be exercised.
        pre_speed = max(55.0, float(previous.get('speed', 0) or 0), float(current.get('speed', 0) or 0) + 22.0)
        duration = 1.30
        peak = -6.50
        mean = -4.55
        jerk = -13.0
        drop = min(pre_speed - 4.0, abs(mean) * duration * 3.6)
        post_speed = max(0.0, pre_speed - drop)
        current['speed'] = round(post_speed, 1)
        harsh_event = {
            'eventType': 'HARSH_BRAKING',
            'isHarshBraking': True,
            'preSpeedKmh': round(pre_speed, 2),
            'postSpeedKmh': round(post_speed, 2),
            'speedDropKmh': round(drop, 2),
            'peakDecelerationMps2': peak,
            'meanDecelerationMps2': mean,
            'maxJerkMps3': jerk,
            'durationSec': duration,
            'reason': 'Controlled replay injection for CALIBR8 dashboard/model validation',
        }

    now_epoch = int(time.time())
    now_iso = _iso_now()
    raw = dict(current)
    raw['sourceDateTime'] = source_ts
    raw['dateTime'] = now_epoch
    raw['replayScenario'] = scenario
    raw['replayIndex'] = idx
    raw['replayCycle'] = cycle
    raw['isReplay'] = True
    raw['harshBrakingEvent'] = harsh_event

    telemetry = {
        'pre_event_speed_kmh': round(pre_speed, 3),
        'post_event_speed_kmh': round(post_speed, 3),
        'speed_drop_kmh': round(drop, 3),
        'peak_deceleration_mps2': round(peak, 4),
        'mean_deceleration_mps2': round(mean, 4),
        'max_jerk_mps3': round(jerk, 4),
        'event_duration_sec': round(duration, 3),
        'gps_quality': 'high',
        'sensor_quality': 'high',
        'timestamp_start': now_iso,
    }

    gps = {
        'lat': float(current['latitude']),
        'lon': float(current['longitude']),
        'speed_kmh': round(post_speed, 3),
        'heading_deg': _heading(current.get('direction')),
        'timestamp': now_iso,
    }

    context = dict(SCENARIOS[scenario]['context'])
    replay = {
        'scenario': scenario,
        'scenarioName': SCENARIOS[scenario]['name'],
        'deviceId': current.get('deviceId') or SCENARIOS[scenario]['device_id'],
        'step': int(step),
        'index': idx,
        'cycle': cycle,
        'totalPoints': len(rows),
        'sourceDateTime': source_ts,
        'sourceDeltaSec': source_dt,
        'derivedLongitudinalAccelMps2': round(longitudinal_accel, 4),
        'harshInjectionIndex': injection_idx,
        'harshInjected': inject,
    }

    return {
        'raw_api_output': raw,
        'telemetry': telemetry,
        'gps': gps,
        'context': context,
        'replay': replay,
        'harsh_event': harsh_event,
    }


def harsh_output_example(scenario: str = 'route_3') -> dict:
    rows = load_route(scenario)
    idx = _harsh_index(rows)
    return build_replay_payload(scenario, idx, harsh_demo=True, force_harsh=True)
