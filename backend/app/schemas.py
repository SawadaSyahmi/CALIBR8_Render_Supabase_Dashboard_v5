from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Literal

Quality = Literal['high','medium','low']

class Telemetry(BaseModel):
    pre_event_speed_kmh: float = 0.0
    post_event_speed_kmh: float | None = None
    speed_drop_kmh: float | None = None
    peak_deceleration_mps2: float = 0.0
    mean_deceleration_mps2: float | None = None
    max_jerk_mps3: float | None = None
    event_duration_sec: float = 1.0
    gps_quality: Quality = 'high'
    sensor_quality: Quality = 'high'
    timestamp_start: str | None = None

class GPSPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    speed_kmh: float | None = None
    heading_deg: float | None = None
    timestamp: str | None = None

class Context(BaseModel):
    vehicle_type: Literal['passenger_car','van_mpv','pickup_4x4','small_lorry','heavy_lorry','bus'] = 'passenger_car'
    road_type: Literal['residential','urban','arterial','highway','rural','industrial'] = 'urban'
    traffic_density: Literal['low','medium','high','stop_go'] = 'medium'
    weather: Literal['clear','cloudy','light_rain','heavy_rain','fog'] = 'clear'
    road_surface: Literal['dry_asphalt','wet_asphalt','rough_asphalt','gravel','pothole_rough','painted_marking'] = 'dry_asphalt'
    road_grade_ratio: float = Field(default=0.0, ge=-0.20, le=0.20)

class IngestBundle(BaseModel):
    telemetry: Telemetry | None = None
    gps: GPSPoint | None = None
    context: Context | None = None
