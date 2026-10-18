from __future__ import annotations

from typing import Any, Literal
from datetime import datetime, timezone
from pydantic import BaseModel, ConfigDict, Field, field_validator
from .connections import DEFAULT_CONTEXT, DEFAULT_MAPPING


class Input(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra='ignore')


def iso_timestamp(value):
    if value is None:
        return value
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('Use an ISO 8601 timestamp.') from exc
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.isoformat()


class LoginInput(Input):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class Selection(Input):
    model: Literal['new_ai', 'friend_gbm'] = 'new_ai'
    mode: Literal['balanced', 'safety'] = 'balanced'


class ReplayInput(Selection):
    scenario: Literal['route_1', 'route_2', 'route_3'] = 'route_1'
    index: int = Field(default=0, ge=0, le=1_000_000)
    run_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    harsh: bool = False
    inject: bool = False


class SyntheticInput(Selection):
    index: int = Field(default=0, ge=0, le=1_000_000)
    run_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')


class Telemetry(Input):
    pre_event_speed_kmh: float = Field(default=0, ge=0, le=500)
    post_event_speed_kmh: float | None = Field(default=None, ge=0, le=500)
    speed_drop_kmh: float | None = Field(default=None, ge=0, le=500)
    peak_deceleration_mps2: float = Field(default=0, ge=-100, le=100)
    mean_deceleration_mps2: float | None = Field(default=None, ge=-100, le=100)
    max_jerk_mps3: float | None = Field(default=None, ge=-1000, le=1000)
    event_duration_sec: float = Field(default=1, gt=0, le=86400)
    gps_quality: Literal['high', 'medium', 'low'] = 'high'
    sensor_quality: Literal['high', 'medium', 'low'] = 'high'
    timestamp_start: str | None = Field(default=None, max_length=80)
    telemetry_source: str | None = Field(default=None, max_length=100)
    validate_timestamp = field_validator('timestamp_start')(iso_timestamp)


class GPSPoint(Input):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    speed_kmh: float | None = Field(default=None, ge=0, le=500)
    heading_deg: float | None = None
    timestamp: str | None = Field(default=None, max_length=80)
    validate_timestamp = field_validator('timestamp')(iso_timestamp)


class Context(Input):
    vehicle_type: Literal['passenger_car', 'van_mpv', 'pickup_4x4', 'small_lorry', 'heavy_lorry', 'bus'] = 'passenger_car'
    road_type: Literal['residential', 'urban', 'arterial', 'highway', 'rural', 'industrial'] = 'urban'
    traffic_density: Literal['low', 'medium', 'high', 'stop_go'] = 'medium'
    weather: Literal['clear', 'cloudy', 'light_rain', 'heavy_rain', 'fog'] = 'clear'
    road_surface: Literal['dry_asphalt', 'wet_asphalt', 'rough_asphalt', 'gravel', 'pothole_rough', 'painted_marking'] = 'dry_asphalt'
    road_grade_ratio: float = Field(default=0, ge=-.2, le=.2)


class EvaluateInput(Selection):
    telemetry: Telemetry
    gps: GPSPoint
    context: Context


class ConnectionInput(Input):
    connection_id: str | None = Field(default=None, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=2000)
    enabled: bool = True
    headers: dict[str, str] | None = None
    root_path: str | None = Field(default=None, max_length=200)
    field_mapping: dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_MAPPING))
    timestamp_format: Literal['epoch_seconds', 'epoch_milliseconds', 'iso'] = 'epoch_seconds'
    speed_unit: Literal['kmh', 'mph', 'mps'] = 'kmh'
    default_context: Context = Field(default_factory=Context)
    poll_interval_sec: int = Field(default=5, ge=1, le=300)


class MonitorInput(Selection):
    connection_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    external_vehicle_id: str = Field(min_length=1, max_length=200)


class VehicleInput(Selection):
    vehicle_id: str = Field(default='device_vehicle', min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')


class IngestInput(VehicleInput):
    telemetry: Telemetry
    gps: GPSPoint
    context: Context = Field(default_factory=Context)
