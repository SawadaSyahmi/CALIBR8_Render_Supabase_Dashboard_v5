from __future__ import annotations

import ipaddress
import json
import socket
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken

from .config import settings

BLOCKED_HEADERS = {"host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization"}
DEFAULT_MAPPING = {
    "device_id": "deviceId",
    "timestamp": "dateTime",
    "latitude": "latitude",
    "longitude": "longitude",
    "speed": "speed",
    "direction": "direction",
}
DEFAULT_CONTEXT = {
    "vehicle_type": "passenger_car",
    "road_type": "urban",
    "traffic_density": "medium",
    "weather": "clear",
    "road_surface": "dry_asphalt",
    "road_grade_ratio": 0.0,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_headers(headers: dict[str, str] | None) -> dict[str, str]:
    clean: dict[str, str] = {}
    for k, v in (headers or {}).items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        if k.strip().lower() in BLOCKED_HEADERS:
            continue
        clean[k.strip()] = v.strip()
    return clean


def encrypt_headers(headers: dict[str, str] | None) -> str:
    clean = _safe_headers(headers)
    if not clean:
        return ""
    if not settings.connection_encryption_key:
        raise ValueError("CONNECTION_ENCRYPTION_KEY is required when API headers/secrets are saved")
    f = Fernet(settings.connection_encryption_key.encode())
    return f.encrypt(json.dumps(clean, separators=(",", ":")).encode()).decode()


def decrypt_headers(token: str | None) -> dict[str, str]:
    if not token:
        return {}
    if not settings.connection_encryption_key:
        raise ValueError("CONNECTION_ENCRYPTION_KEY is not configured")
    try:
        raw = Fernet(settings.connection_encryption_key.encode()).decrypt(token.encode())
        return _safe_headers(json.loads(raw.decode()))
    except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Stored API headers could not be decrypted") from exc


def public_connection(doc: dict[str, Any]) -> dict[str, Any]:
    out = dict(doc)
    secret = out.pop("headers_encrypted", "")
    out["has_headers"] = bool(secret)
    out.pop("headers", None)
    return out


def _host_is_public(hostname: str) -> bool:
    try:
        addresses = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        # Let httpx return the actual DNS error later.
        return True
    for item in addresses:
        ip = ipaddress.ip_address(item[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_private or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False
    return True


def validate_external_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("API URL must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("Credentials in the URL are not allowed; use request headers instead")
    if not settings.allow_private_api_hosts and not _host_is_public(parsed.hostname):
        raise ValueError("Private/loopback/link-local API hosts are blocked for security")
    return url.strip()


def _path_get(value: Any, path: str | None) -> Any:
    if not path:
        return value
    cur = value
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            idx = int(part)
            cur = cur[idx] if 0 <= idx < len(cur) else None
        else:
            return None
    return cur


def extract_records(payload: Any, root_path: str | None = None) -> list[dict[str, Any]]:
    payload = _path_get(payload, root_path)
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        # Common API wrappers.
        for key in ("data", "items", "results", "vehicles", "records"):
            candidate = payload.get(key)
            if isinstance(candidate, list):
                return [r for r in candidate if isinstance(r, dict)]
        return [payload]
    return []


def _num(v: Any, default: float | None = None) -> float | None:
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _timestamp_seconds(v: Any, mode: str) -> float:
    if v is None:
        return time.time()
    if mode == "epoch_milliseconds":
        return float(v) / 1000.0
    if mode == "iso":
        s = str(v).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return float(v)


def _iso_from_seconds(v: float) -> str:
    return datetime.fromtimestamp(v, tz=timezone.utc).isoformat()


def normalize_record(record: dict[str, Any], connection: dict[str, Any]) -> dict[str, Any] | None:
    mapping = {**DEFAULT_MAPPING, **(connection.get("field_mapping") or {})}
    device = _path_get(record, mapping["device_id"])
    lat = _num(_path_get(record, mapping["latitude"]))
    lon = _num(_path_get(record, mapping["longitude"]))
    if device in (None, "") or lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return None
    speed = _num(_path_get(record, mapping["speed"]), 0.0) or 0.0
    unit = connection.get("speed_unit", "kmh")
    if unit == "mph":
        speed *= 1.609344
    elif unit == "mps":
        speed *= 3.6
    heading = _num(_path_get(record, mapping["direction"]))
    ts_raw = _path_get(record, mapping["timestamp"])
    try:
        ts = _timestamp_seconds(ts_raw, connection.get("timestamp_format", "epoch_seconds"))
    except Exception:
        ts = time.time()
    return {
        "external_vehicle_id": str(device),
        "timestamp_epoch": ts,
        "timestamp": _iso_from_seconds(ts),
        "lat": lat,
        "lon": lon,
        "speed_kmh": speed,
        "heading_deg": heading,
        "raw": record,
    }


def latest_by_vehicle(payload: Any, connection: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in extract_records(payload, connection.get("root_path")):
        n = normalize_record(record, connection)
        if not n:
            continue
        groups.setdefault(n["external_vehicle_id"], []).append(n)
    for rows in groups.values():
        rows.sort(key=lambda r: r["timestamp_epoch"])
    return groups


def build_context(connection: dict[str, Any]) -> dict[str, Any]:
    return {**DEFAULT_CONTEXT, **(connection.get("default_context") or {})}


def telemetry_from_points(current: dict[str, Any], previous: dict[str, Any] | None, fallback_previous: dict[str, Any] | None = None) -> dict[str, Any]:
    prev = previous or fallback_previous
    pre_speed = float(prev.get("speed_kmh", current["speed_kmh"]) if prev else current["speed_kmh"])
    post_speed = float(current["speed_kmh"])
    if prev:
        try:
            prev_ts = float(prev.get("timestamp_epoch")) if prev.get("timestamp_epoch") is not None else datetime.fromisoformat(str(prev.get("timestamp")).replace("Z", "+00:00")).timestamp()
        except Exception:
            prev_ts = current["timestamp_epoch"] - 1.0
        dt = max(0.25, min(30.0, current["timestamp_epoch"] - prev_ts))
    else:
        dt = 1.0
    delta_mps = (post_speed - pre_speed) / 3.6
    accel = delta_mps / dt
    decel = min(accel, 0.0)
    # GPS-speed-only feeds cannot provide a true IMU peak; this is explicitly an estimate.
    mean_decel = decel
    peak_decel = decel * 1.15 if decel < 0 else 0.0
    prior_accel = _num(prev.get("derived_accel_mps2"), 0.0) if prev else 0.0
    jerk = (accel - float(prior_accel or 0.0)) / dt
    return {
        "pre_event_speed_kmh": pre_speed,
        "post_event_speed_kmh": post_speed,
        "speed_drop_kmh": max(0.0, pre_speed - post_speed),
        "peak_deceleration_mps2": peak_decel,
        "mean_deceleration_mps2": mean_decel,
        "max_jerk_mps3": min(jerk, 0.0),
        "event_duration_sec": dt,
        "gps_quality": "high",
        "sensor_quality": "medium",
        "timestamp_start": current["timestamp"],
        "telemetry_source": "derived_from_gps_speed",
    }


async def fetch_connection(connection: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    url = validate_external_url(str(connection.get("url", "")))
    headers = decrypt_headers(connection.get("headers_encrypted"))
    t = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.poll_timeout_sec, follow_redirects=False) as client:
            r = await client.get(url, headers=headers)
            if 300 <= r.status_code < 400:
                raise ValueError("Redirect responses are disabled for customer API connections")
            r.raise_for_status()
            if len(r.content) > settings.max_external_response_bytes:
                raise ValueError("API response exceeds configured size limit")
            payload = r.json()
        return payload, {
            "ok": True,
            "latency_ms": round((time.perf_counter() - t) * 1000, 1),
            "status_code": r.status_code,
            "message": "connected",
        }
    except Exception as exc:
        return None, {
            "ok": False,
            "latency_ms": round((time.perf_counter() - t) * 1000, 1),
            "message": str(exc)[:220],
        }
