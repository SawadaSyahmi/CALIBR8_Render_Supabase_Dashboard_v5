from __future__ import annotations
import math

G = 9.80665
RHO_AIR = 1.225
BRAKE_CAPABILITY_GAIN = 8.2
TRUE_BANDS = (0.40, 0.60, 0.80)

VEHICLE_PROFILES = {
    'passenger_car': {'mass': 1400, 'CdA': 0.65, 'Crr': 0.012, 'brake_eff': 0.89},
    'van_mpv':       {'mass': 2200, 'CdA': 0.875,'Crr': 0.0145,'brake_eff': 0.85},
    'pickup_4x4':    {'mass': 2450, 'CdA': 0.95, 'Crr': 0.016, 'brake_eff': 0.835},
    'small_lorry':   {'mass': 5500, 'CdA': 1.75, 'Crr': 0.020, 'brake_eff': 0.75},
    'heavy_lorry':   {'mass': 17000,'CdA': 3.75, 'Crr': 0.024, 'brake_eff': 0.705},
    'bus':           {'mass': 12500,'CdA': 3.00, 'Crr': 0.021, 'brake_eff': 0.715},
}

SURFACE_WEATHER_MU = {
    'dry_asphalt':     {'clear':0.82,'cloudy':0.80,'light_rain':0.68,'heavy_rain':0.56,'fog':0.72},
    'wet_asphalt':     {'clear':0.64,'cloudy':0.63,'light_rain':0.61,'heavy_rain':0.54,'fog':0.59},
    'rough_asphalt':   {'clear':0.74,'cloudy':0.72,'light_rain':0.64,'heavy_rain':0.55,'fog':0.66},
    'gravel':          {'clear':0.50,'cloudy':0.49,'light_rain':0.45,'heavy_rain':0.40,'fog':0.47},
    'pothole_rough':   {'clear':0.60,'cloudy':0.58,'light_rain':0.52,'heavy_rain':0.45,'fog':0.54},
    'painted_marking': {'clear':0.48,'cloudy':0.46,'light_rain':0.36,'heavy_rain':0.30,'fog':0.40},
}

def physics_calculation(event: dict) -> dict:
    vt = event['vehicle_type']; profile = VEHICLE_PROFILES[vt]
    speed = max(float(event.get('pre_event_speed_kmh',0.0)),0.0)
    grade = float(event.get('road_grade_ratio',0.0))
    theta = math.atan(grade)
    mu = SURFACE_WEATHER_MU[event['road_surface']][event['weather']]
    if event['weather'] in {'light_rain','heavy_rain','fog'}:
        penalty = min(max((speed - 70.0)/120.0, 0.0), 0.12)
        mu *= (1.0 - penalty)
    a_traction = max(0.6, min(9.5, mu*G*math.cos(theta) + G*math.sin(theta)))
    a_capability = BRAKE_CAPABILITY_GAIN * profile['brake_eff']
    a_available = min(a_traction, a_capability)
    v = speed / 3.6
    a_drag = 0.5*RHO_AIR*profile['CdA']*v*v/profile['mass']
    a_roll = profile['Crr']*G*math.cos(theta)
    peak = abs(float(event.get('peak_deceleration_mps2',0.0)))
    a_brake_obs = max(0.0, peak - a_drag - a_roll)
    utilisation = min(max(a_brake_obs/max(a_available,1e-9),0.0),1.0)
    if utilisation < TRUE_BANDS[0]: label='normal'
    elif utilisation < TRUE_BANDS[1]: label='mild_braking'
    elif utilisation < TRUE_BANDS[2]: label='harsh_braking'
    else: label='severe_braking'
    return {
        'mu_est': mu, 'road_angle_deg': math.degrees(theta),
        'a_traction_mps2': a_traction, 'a_capability_mps2': a_capability,
        'a_available_mps2': a_available, 'aero_drag_mps2': a_drag,
        'rolling_resistance_mps2': a_roll, 'observed_brake_component_mps2': a_brake_obs,
        'utilisation': utilisation, 'physics_label': label,
        'physics_harsh_or_severe': label in {'harsh_braking','severe_braking'},
        'formulae': {
            'traction': 'a_traction = μg cos(θ) + g sin(θ)',
            'drag': 'a_drag = 0.5 ρ CdA v² / m',
            'rolling': 'a_roll = Crr g cos(θ)',
            'available': 'a_available = min(a_traction, a_capability)',
            'utilisation': 'u = a_brake_observed / a_available',
        }
    }
