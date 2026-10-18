from __future__ import annotations
import json, os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / 'models'
PUBLIC_DIR = BASE_DIR.parent / 'public'

class Settings:
    supabase_url = os.getenv('SUPABASE_URL', '').strip().rstrip('/')
    supabase_anon_key = os.getenv('SUPABASE_ANON_KEY', '').strip()
    supabase_service_role_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    default_vehicle_id = os.getenv('DEFAULT_VEHICLE_ID', 'demo_vehicle')
    workspace_id = os.getenv('WORKSPACE_ID', 'main')
    ingest_api_key = os.getenv('INGEST_API_KEY', '')
    connection_encryption_key = os.getenv('CONNECTION_ENCRYPTION_KEY', '').strip()
    allow_private_api_hosts = os.getenv('ALLOW_PRIVATE_API_HOSTS', 'false').lower() in {'1','true','yes','on'}
    max_external_response_bytes = int(os.getenv('MAX_EXTERNAL_RESPONSE_BYTES', '5000000'))
    allow_demo = os.getenv('ALLOW_DEMO', 'true').lower() in {'1','true','yes','on'}
    allow_unauthenticated_dashboard = os.getenv('ALLOW_UNAUTHENTICATED_DASHBOARD', 'false').lower() in {'1','true','yes','on'}
    poll_timeout_sec = float(os.getenv('POLL_TIMEOUT_SEC', '8'))
    telemetry_api_url = os.getenv('TELEMETRY_API_URL', '').strip()
    gps_api_url = os.getenv('GPS_API_URL', '').strip()
    context_api_url = os.getenv('CONTEXT_API_URL', '').strip()
    telemetry_api_headers = json.loads(os.getenv('TELEMETRY_API_HEADERS', '{}'))
    gps_api_headers = json.loads(os.getenv('GPS_API_HEADERS', '{}'))
    context_api_headers = json.loads(os.getenv('CONTEXT_API_HEADERS', '{}'))

settings = Settings()
