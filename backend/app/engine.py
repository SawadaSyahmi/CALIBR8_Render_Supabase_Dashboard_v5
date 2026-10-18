"""Pure frame construction shared by replay, API monitoring and devices."""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import math
from .models import feature_row
from .physics import physics_calculation
from .replay import load_route, build_replay_payload, SCENARIOS
from .schemas import Telemetry, GPSPoint, Context


def now():
    return datetime.now(timezone.utc).isoformat()


def distance_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    value = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742.0176 * math.asin(min(1, math.sqrt(value)))


@lru_cache(maxsize=3)
def route_distances(scenario):
    points = [{'lat': float(r['latitude']), 'lon': float(r['longitude'])} for r in load_route(scenario)]
    totals = [0.0]
    for a, b in zip(points, points[1:]):
        increment = distance_km(a, b)
        totals.append(totals[-1] + (increment if increment < 2 else 0))
    return tuple(totals)


def evaluate(hub, telemetry, gps, context, model='new_ai', mode='balanced'):
    t = Telemetry.model_validate(telemetry).model_dump(exclude_none=True)
    g = GPSPoint.model_validate(gps).model_dump(exclude_none=True)
    c = Context.model_validate(context).model_dump()
    t['timestamp_start'] = t.get('timestamp_start') or g.get('timestamp') or now()
    event = feature_row({**t, **c}).iloc[0].to_dict()
    event.update(c, timestamp_start=t['timestamp_start'])
    # Resolve optional input values once; every UI card receives the same values the models used.
    for field in ('post_event_speed_kmh', 'speed_drop_kmh', 'mean_deceleration_mps2', 'max_jerk_mps3'):
        t[field] = event[field]
    comparison = {'new_ai': hub.new_ai(event, mode), 'friend_gbm': hub.friend_gbm(event)}
    return {'telemetry': t, 'gps': g, 'context': c, 'physics': physics_calculation(event),
            'models': comparison, 'selected_model': model, 'mode': mode, 'decision': comparison[model]}


def make_frame(hub, t, g, c, *, vehicle_id, source, identity, model='new_ai', mode='balanced', raw=None):
    values = evaluate(hub, t, g, c, model, mode)
    frame_id = hashlib.sha256((vehicle_id + '|' + identity).encode()).hexdigest()[:28]
    point = {**values['gps'], 'id': frame_id, 'frame_id': frame_id}
    selected = values['decision']
    event = None
    if selected['harsh_or_severe']:
        event = {'event_id': frame_id, 'frame_id': frame_id, 'timestamp': values['telemetry']['timestamp_start'], 'model': selected['model'],
                 'model_key': model, 'mode': mode, 'probability': selected['probability_harsh'],
                 'speed_kmh': values['telemetry']['pre_event_speed_kmh'],
                 'peak_decel_mps2': values['telemetry']['peak_deceleration_mps2'],
                 'physics_label': values['physics']['physics_label'], 'utilisation': values['physics']['utilisation'],
                 'lat': g['lat'], 'lon': g['lon']}
    return {'schema_version': 7, 'frame_id': frame_id, 'source': source, 'vehicle_id': vehicle_id,
            'server_time': now(), **values, 'route_point': point, 'event': event, 'raw_api_output': raw,
            'quality': {'note': 'Braking estimated from GPS speed; this is not an IMU peak measurement.' if t.get('telemetry_source') == 'derived_from_gps_speed' else 'Controlled sample dynamics' if source in {'sample', 'synthetic'} else 'Device telemetry'},
            'persistence': {'saved': False, 'message': 'Sample session; live history is unchanged.'}}


def replay_frame(hub, request):
    total = len(load_route(request.scenario))
    index = min(request.index, total - 1)
    pack = build_replay_payload(request.scenario, index, harsh_demo=request.harsh, force_harsh=request.inject)
    frame = make_frame(hub, pack['telemetry'], pack['gps'], pack['context'], vehicle_id='sample_' + request.scenario,
                       source='sample', identity=request.run_id + ':' + str(index), model=request.model, mode=request.mode,
                       raw=pack['raw_api_output'])
    frame.update(replay=pack['replay'], harsh_event=pack['harsh_event'], run_id=request.run_id,
                 complete=index == total - 1,
                 trip={'active_trip_id': request.run_id, 'distance_km': route_distances(request.scenario)[index], 'route_points': index + 1})
    return frame
