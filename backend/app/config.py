"""Environment configuration. Database operations use the signed-in user's JWT."""
from __future__ import annotations

import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / 'models'
PUBLIC_DIR = BASE_DIR.parent / 'public'


class Settings:
    def __init__(self):
        self.supabase_url = os.getenv('SUPABASE_URL', '').strip().rstrip('/')
        self.supabase_publishable_key = (os.getenv('SUPABASE_PUBLISHABLE_KEY') or os.getenv('SUPABASE_ANON_KEY') or '').strip()
        self.connection_encryption_key = os.getenv('CONNECTION_ENCRYPTION_KEY', '').strip()
        self.ingest_api_key = os.getenv('INGEST_API_KEY', '').strip()
        self.allow_demo = os.getenv('ALLOW_DEMO', 'true').lower() in {'1', 'true', 'yes'}
        self.allow_private_api_hosts = os.getenv('ALLOW_PRIVATE_API_HOSTS', 'false').lower() in {'1', 'true', 'yes'}
        self.max_external_response_bytes = int(os.getenv('MAX_EXTERNAL_RESPONSE_BYTES', '5000000'))
        self.poll_timeout_sec = float(os.getenv('POLL_TIMEOUT_SEC', '10'))
        self.telemetry_api_url = os.getenv('TELEMETRY_API_URL', '').strip()
        self.gps_api_url = os.getenv('GPS_API_URL', '').strip()
        self.context_api_url = os.getenv('CONTEXT_API_URL', '').strip()
        for name in ('telemetry', 'gps', 'context'):
            setattr(self, name + '_api_headers', json.loads(os.getenv(name.upper() + '_API_HEADERS', '{}')))

    @property
    def configured(self):
        return bool(self.supabase_url and self.supabase_publishable_key)


settings = Settings()
