from __future__ import annotations
import asyncio, time
import httpx
from .config import settings
from .schemas import Telemetry, GPSPoint, Context

async def _get(url,headers,name):
    if not url: return None, {'ok':False,'source':'external','latency_ms':0,'message':'URL not configured'}
    t=time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.poll_timeout_sec) as client:
            r=await client.get(url,headers=headers); r.raise_for_status(); data=r.json()
        return data, {'ok':True,'source':'external','latency_ms':round((time.perf_counter()-t)*1000,1),'message':'connected'}
    except Exception as e:
        return None, {'ok':False,'source':'external','latency_ms':round((time.perf_counter()-t)*1000,1),'message':str(e)[:120]}

async def read_external():
    (tr,ts),(gr,gs),(cr,cs)=await asyncio.gather(
        _get(settings.telemetry_api_url,settings.telemetry_api_headers,'telemetry'),
        _get(settings.gps_api_url,settings.gps_api_headers,'gps'),
        _get(settings.context_api_url,settings.context_api_headers,'context'))
    if tr is None or gr is None or cr is None:
        return None, {'telemetry':ts,'gps':gs,'context':cs}
    try:
        return (Telemetry.model_validate(tr),GPSPoint.model_validate(gr),Context.model_validate(cr)), {'telemetry':ts,'gps':gs,'context':cs}
    except Exception as e:
        return None, {'telemetry':ts,'gps':gs,'context':cs,'schema_error':str(e)}
