from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .auth import dashboard_auth, ingest_auth
from .config import settings
from .connections import (
    DEFAULT_CONTEXT,
    DEFAULT_MAPPING,
    build_context,
    encrypt_headers,
    fetch_connection,
    latest_by_vehicle,
    public_connection,
    telemetry_from_points,
    validate_external_url,
)
from .demo import demo_payload
from .models import ModelHub, feature_row
from .physics import physics_calculation
from .schemas import Telemetry, GPSPoint, Context
from .sources import read_external
from .replay import build_replay_payload, harsh_output_example, list_scenarios, SCENARIOS
from .store import SupabaseStore, utcnow_iso

app=FastAPI(title='CALIBR8 Render + Supabase Fleet API',version='5.1')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['*'],allow_headers=['*'])
store=SupabaseStore(); models=ModelHub()


class InferenceRequest(BaseModel):
    vehicle_id:str=settings.default_vehicle_id
    model:str='new_ai'
    mode:str='balanced'

class ResetRequest(BaseModel):
    vehicle_id:str=settings.default_vehicle_id

class ReplayRequest(InferenceRequest):
    scenario:str='route_1'

class ReplayResetRequest(BaseModel):
    vehicle_id:str=settings.default_vehicle_id
    scenario:str='route_1'

class ConnectionInput(BaseModel):
    connection_id: str | None = None
    name: str = Field(min_length=1,max_length=80)
    url: str = Field(min_length=8,max_length=2000)
    enabled: bool = True
    headers: dict[str,str] | None = None
    root_path: str | None = Field(default=None,max_length=200)
    field_mapping: dict[str,str] = Field(default_factory=lambda: dict(DEFAULT_MAPPING))
    timestamp_format: Literal['epoch_seconds','epoch_milliseconds','iso'] = 'epoch_seconds'
    speed_unit: Literal['kmh','mph','mps'] = 'kmh'
    default_context: dict[str,Any] = Field(default_factory=lambda: dict(DEFAULT_CONTEXT))
    poll_interval_sec: int = Field(default=5,ge=1,le=300)

class ConnectionTestRequest(BaseModel):
    connection_id: str

class MonitorRequest(BaseModel):
    connection_id: str
    external_vehicle_id: str
    model: Literal['new_ai','friend_gbm'] = 'new_ai'
    mode: Literal['balanced','safety'] = 'balanced'


def customer_id(auth_payload:dict)->str:
    # Single organization/customer. Authentication controls access only; it no longer creates tenants.
    return settings.workspace_id

def safe_external_vehicle_id(connection_id:str, external_vehicle_id:str)->str:
    digest=hashlib.sha1(external_vehicle_id.encode()).hexdigest()[:12]
    short=re.sub(r'[^A-Za-z0-9_-]','',connection_id)[:8] or 'api'
    return f'ext_{short}_{digest}'

def merge_event(t:dict,g:dict,c:dict)->dict:
    d={**t,**c}
    if d.get('timestamp_start') is None: d['timestamp_start']=g.get('timestamp') or utcnow_iso()
    if d.get('pre_event_speed_kmh') in (None,0) and g.get('speed_kmh') is not None: d['pre_event_speed_kmh']=g['speed_kmh']
    normalized=feature_row(d).iloc[0].to_dict(); normalized.update(c); normalized['timestamp_start']=d['timestamp_start']
    return normalized

def infer_and_store(cid:str,vehicle_id:str,model_name:str,mode:str):
    t=store.get_live(cid,vehicle_id,'telemetry'); g=store.get_live(cid,vehicle_id,'gps'); c=store.get_live(cid,vehicle_id,'context')
    if not (t and g and c): raise HTTPException(status_code=409,detail='Telemetry, GPS and context must be available before inference')
    event=merge_event(t,g,c); phys=physics_calculation(event)
    new_ai=models.new_ai(event,mode); friend=models.friend_gbm(event)
    selected=new_ai if model_name=='new_ai' else friend
    payload={'server_time':utcnow_iso(),'vehicle_id':vehicle_id,'telemetry':t,'input':event,'physics':phys,'selected_model':model_name,'selected_mode':mode,
             'inference':selected,'model_comparison':{'new_ai':new_ai,'friend_gbm':friend},'gps':g,'context':c}
    latest_event=None
    if selected['harsh_or_severe']:
        raw=f"{vehicle_id}|{event.get('timestamp_start')}|{model_name}|{mode}".encode(); event_id=hashlib.sha1(raw).hexdigest()[:20]
        e={'event_id':event_id,'timestamp':event.get('timestamp_start') or utcnow_iso(),'model':selected['model'],'model_key':model_name,'mode':mode,
           'probability':float(selected['probability_harsh']),'speed_kmh':float(event.get('pre_event_speed_kmh',0)),
           'peak_decel_mps2':float(event.get('peak_deceleration_mps2',0)),'physics_label':phys['physics_label'],'utilisation':phys['utilisation'],
           'lat':float(g['lat']),'lon':float(g['lon'])}
        store.record_event(cid,vehicle_id,event_id,e)
        latest_event=e
    # Every successful response carries the values needed by the measurement cards.
    # Realtime is an additional delivery path, never a prerequisite for rendering.
    trip=store.get_live(cid,vehicle_id,'trip') or {}
    payload.update(trip=trip,route_point=trip.get('last_route_point'),event=latest_event)
    store.set_live(cid,vehicle_id,'inference',payload)
    return payload

def replay_and_store(cid:str,req:ReplayRequest,harsh_demo:bool=False,force_harsh:bool=False):
    if not settings.allow_demo: raise HTTPException(403,'Replay/demo mode disabled')
    if req.scenario not in SCENARIOS: raise HTTPException(400,f'Unknown scenario: {req.scenario}')
    step=store.next_replay_step(cid,req.vehicle_id,req.scenario,harsh_demo)
    pack=build_replay_payload(req.scenario,step,harsh_demo=harsh_demo,force_harsh=force_harsh)
    t=Telemetry.model_validate(pack['telemetry']); g=GPSPoint.model_validate(pack['gps']); c=Context.model_validate(pack['context'])
    store.set_live(cid,req.vehicle_id,'telemetry',t.model_dump())
    store.set_live(cid,req.vehicle_id,'gps',g.model_dump()); store.add_gps(cid,req.vehicle_id,g.model_dump())
    store.set_live(cid,req.vehicle_id,'context',c.model_dump()); store.set_live(cid,req.vehicle_id,'raw_api',pack['raw_api_output'])
    out=infer_and_store(cid,req.vehicle_id,req.model,req.mode)
    out['replay']=pack['replay']; out['raw_api_output']=pack['raw_api_output']; out['harsh_event']=pack['harsh_event']
    store.set_live(cid,req.vehicle_id,'inference',out)
    return out


def connection_for_customer(cid:str, connection_id:str)->dict:
    conn=store.get_connection(cid,connection_id)
    if not conn: raise HTTPException(404,'API connection not found')
    return conn

async def discover_one(cid:str,conn:dict)->dict:
    payload,status=await fetch_connection(conn)
    if payload is None:
        return {'connection_id':conn['connection_id'],'name':conn.get('name'),'ok':False,'status':status,'vehicles':[]}
    groups=latest_by_vehicle(payload,conn)
    vehicles=[]
    for external_id,rows in groups.items():
        last=rows[-1]
        internal=safe_external_vehicle_id(conn['connection_id'],external_id)
        summary={
            'connection_id':conn['connection_id'],'connection_name':conn.get('name','API'),
            'external_vehicle_id':external_id,'internal_vehicle_id':internal,
            'lat':last['lat'],'lon':last['lon'],'speed_kmh':last['speed_kmh'],'heading_deg':last.get('heading_deg'),
            'source_timestamp':last['timestamp'],'source_timestamp_epoch':last['timestamp_epoch'],
            'last_seen':last['timestamp'],'status':'online' if status.get('ok') else 'unknown'
        }
        store.save_fleet_vehicle(cid,internal,summary); vehicles.append(summary)
    vehicles.sort(key=lambda x:(x['connection_name'],x['external_vehicle_id']))
    return {'connection_id':conn['connection_id'],'name':conn.get('name'),'ok':True,'status':status,'vehicles':vehicles}


@app.get('/api/health')
def health():
    return {'ok':True,'deployment':'Render + Supabase','models':['new_ai','friend_gbm'],
            'features':['single_customer','multi_api_connections','fleet_vehicle_selector','route_monitoring','supabase_realtime']}

@app.get('/api/client-config')
def client_config():
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=503,detail='SUPABASE_URL and SUPABASE_ANON_KEY are not configured')
    return {'supabase_url':settings.supabase_url,'supabase_anon_key':settings.supabase_anon_key}

@app.get('/api/state')
def dashboard_state(vehicle_id:str=Query(settings.default_vehicle_id),auth_payload=Depends(dashboard_auth)):
    """Authenticated read fallback for startup, push mode, routes and event history."""
    cid=customer_id(auth_payload)
    live=store.get_dashboard_live(cid,vehicle_id)
    trip_id=(live.get('trip') or {}).get('active_trip_id')
    return {'vehicle_id':vehicle_id,'live':live,
            'route_points':store.list_route_points(cid,vehicle_id,trip_id) if trip_id else [],
            'events':store.list_events(cid,vehicle_id,trip_id,limit=50) if trip_id else []}

# Direct push ingestion. All authorized/device writes go to the single organization workspace.
@app.post('/api/ingest/telemetry')
def ingest_telemetry(value:Telemetry,vehicle_id:str=Query(settings.default_vehicle_id),customer_id_q:str=Query('legacy'),_=Depends(ingest_auth)):
    return {'ok':True,'data':store.set_live(customer_id_q,vehicle_id,'telemetry',value.model_dump())}

@app.post('/api/ingest/gps')
def ingest_gps(value:GPSPoint,vehicle_id:str=Query(settings.default_vehicle_id),customer_id_q:str=Query('legacy'),_=Depends(ingest_auth)):
    store.set_live(customer_id_q,vehicle_id,'gps',value.model_dump()); trip=store.add_gps(customer_id_q,vehicle_id,value.model_dump()); return {'ok':True,'trip':trip}

@app.post('/api/ingest/context')
def ingest_context(value:Context,vehicle_id:str=Query(settings.default_vehicle_id),customer_id_q:str=Query('legacy'),_=Depends(ingest_auth)):
    return {'ok':True,'data':store.set_live(customer_id_q,vehicle_id,'context',value.model_dump())}

@app.post('/api/inference')
def inference(req:InferenceRequest,auth_payload=Depends(dashboard_auth)):
    return infer_and_store(customer_id(auth_payload),req.vehicle_id,req.model,req.mode)

@app.post('/api/demo/tick')
def demo_tick(req:InferenceRequest,auth_payload=Depends(dashboard_auth)):
    if not settings.allow_demo: raise HTTPException(403,'Demo mode disabled')
    cid=customer_id(auth_payload); step=store.next_demo_step(cid,req.vehicle_id); t,g,c=demo_payload(step)
    store.set_live(cid,req.vehicle_id,'telemetry',t); store.set_live(cid,req.vehicle_id,'gps',g); store.add_gps(cid,req.vehicle_id,g); store.set_live(cid,req.vehicle_id,'context',c)
    return infer_and_store(cid,req.vehicle_id,req.model,req.mode)

@app.get('/api/replay/scenarios')
def replay_scenarios():
    if not settings.allow_demo: raise HTTPException(403,'Replay/demo mode disabled')
    return {'scenarios':list_scenarios()}

@app.get('/api/mock/live')
def mock_live(scenario:str=Query('route_1'),vehicle_id:str=Query('mock_api')):
    if not settings.allow_demo: raise HTTPException(403,'Replay/demo mode disabled')
    if scenario not in SCENARIOS: raise HTTPException(400,f'Unknown scenario: {scenario}')
    # Public mock uses an isolated demo customer only.
    step=store.next_replay_step('public_mock',vehicle_id,scenario,False)
    return [build_replay_payload(scenario,step,harsh_demo=False)['raw_api_output']]

@app.get('/api/mock/harsh-event')
def mock_harsh_event(scenario:str=Query('route_3')):
    if not settings.allow_demo: raise HTTPException(403,'Replay/demo mode disabled')
    if scenario not in SCENARIOS: raise HTTPException(400,f'Unknown scenario: {scenario}')
    return [harsh_output_example(scenario)['raw_api_output']]

@app.post('/api/replay/tick')
def replay_tick(req:ReplayRequest,auth_payload=Depends(dashboard_auth)):
    return replay_and_store(customer_id(auth_payload),req,harsh_demo=False)

@app.post('/api/replay/harsh/tick')
def replay_harsh_tick(req:ReplayRequest,auth_payload=Depends(dashboard_auth)):
    return replay_and_store(customer_id(auth_payload),req,harsh_demo=True)

@app.post('/api/replay/inject')
def replay_inject(req:ReplayRequest,auth_payload=Depends(dashboard_auth)):
    return replay_and_store(customer_id(auth_payload),req,harsh_demo=False,force_harsh=True)

@app.post('/api/replay/reset')
def replay_reset(req:ReplayResetRequest,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload)
    if req.scenario not in SCENARIOS: raise HTTPException(400,f'Unknown scenario: {req.scenario}')
    return {'ok':True,'replay':store.reset_replay(cid,req.vehicle_id,req.scenario),'trip':store.reset_trip(cid,req.vehicle_id)}

@app.post('/api/sync')
async def sync_external(req:InferenceRequest,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); found,status=await read_external()
    if found is None: raise HTTPException(status_code=502,detail={'message':'One or more external APIs failed','status':status})
    t,g,c=found
    store.set_live(cid,req.vehicle_id,'telemetry',t.model_dump()); store.set_live(cid,req.vehicle_id,'gps',g.model_dump()); store.add_gps(cid,req.vehicle_id,g.model_dump()); store.set_live(cid,req.vehicle_id,'context',c.model_dump())
    out=infer_and_store(cid,req.vehicle_id,req.model,req.mode); out['external_api_status']=status; return out

@app.post('/api/reset')
def reset(req:ResetRequest,auth_payload=Depends(dashboard_auth)):
    return {'ok':True,'trip':store.reset_trip(customer_id(auth_payload),req.vehicle_id)}

@app.get('/api/export/events.csv')
def export_events(vehicle_id:str=Query(settings.default_vehicle_id),trip_id:str=Query(...),auth_payload=Depends(dashboard_auth)):
    events=store.list_events(customer_id(auth_payload),vehicle_id,trip_id)
    cols=['timestamp','model','mode','probability','speed_kmh','peak_decel_mps2','physics_label','utilisation','lat','lon']
    s=io.StringIO(); w=csv.DictWriter(s,fieldnames=cols); w.writeheader();
    for e in events: w.writerow({k:e.get(k) for k in cols})
    return Response(content=s.getvalue(),media_type='text/csv',headers={'Content-Disposition':f'attachment; filename=calibr8_{trip_id}_events.csv'})

# Organization live API connections -------------------------------------------------
@app.get('/api/connections')
@app.get('/api/customer/connections', include_in_schema=False)
def list_customer_connections(auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); store.ensure_customer(cid,auth_payload.get('email'))
    rows=sorted(store.list_connections(cid),key=lambda x:x.get('name','').lower())
    return {'connections':[public_connection(x) for x in rows]}

@app.post('/api/connections')
@app.post('/api/customer/connections', include_in_schema=False)
def save_customer_connection(value:ConnectionInput,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); store.ensure_customer(cid,auth_payload.get('email'))
    try: url=validate_external_url(value.url)
    except ValueError as exc: raise HTTPException(400,str(exc)) from exc
    try: Context.model_validate({**DEFAULT_CONTEXT,**value.default_context})
    except Exception as exc: raise HTTPException(400,f'Invalid default context: {exc}') from exc
    connection_id=value.connection_id or uuid.uuid4().hex[:16]
    old=store.get_connection(cid,connection_id) or {}
    if value.headers is None:
        enc=old.get('headers_encrypted','')
    else:
        try: enc=encrypt_headers(value.headers)
        except ValueError as exc: raise HTTPException(503,str(exc)) from exc
    doc={
        'name':value.name.strip(),'url':url,'enabled':value.enabled,'headers_encrypted':enc,
        'root_path':(value.root_path or '').strip() or None,
        'field_mapping':{**DEFAULT_MAPPING,**value.field_mapping},'timestamp_format':value.timestamp_format,
        'speed_unit':value.speed_unit,'default_context':{**DEFAULT_CONTEXT,**value.default_context},
        'poll_interval_sec':value.poll_interval_sec,
    }
    saved=store.save_connection(cid,connection_id,doc)
    return {'ok':True,'connection':public_connection(saved)}

@app.delete('/api/connections/{connection_id}')
@app.delete('/api/customer/connections/{connection_id}', include_in_schema=False)
def delete_customer_connection(connection_id:str,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); connection_for_customer(cid,connection_id); store.delete_connection(cid,connection_id)
    return {'ok':True}

@app.post('/api/connections/{connection_id}/test')
@app.post('/api/customer/connections/{connection_id}/test', include_in_schema=False)
async def test_customer_connection(connection_id:str,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); conn=connection_for_customer(cid,connection_id)
    result=await discover_one(cid,conn)
    return result

@app.post('/api/fleet/discover')
@app.post('/api/customer/fleet/discover', include_in_schema=False)
async def discover_customer_fleet(auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); store.ensure_customer(cid,auth_payload.get('email'))
    conns=[c for c in store.list_connections(cid) if c.get('enabled',True)]
    if not conns: return {'connections':[],'vehicles':[]}
    results=await asyncio.gather(*(discover_one(cid,c) for c in conns))
    vehicles=[v for r in results for v in r.get('vehicles',[])]
    vehicles.sort(key=lambda x:(x.get('connection_name',''),x.get('external_vehicle_id','')))
    return {'connections':results,'vehicles':vehicles}

@app.get('/api/fleet')
@app.get('/api/customer/fleet', include_in_schema=False)
def customer_fleet(auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload)
    rows=sorted(store.list_fleet(cid),key=lambda x:(x.get('connection_name',''),x.get('external_vehicle_id','')))
    return {'vehicles':rows}

@app.post('/api/monitor/tick')
@app.post('/api/customer/monitor/tick', include_in_schema=False)
async def customer_monitor_tick(req:MonitorRequest,auth_payload=Depends(dashboard_auth)):
    cid=customer_id(auth_payload); conn=connection_for_customer(cid,req.connection_id)
    if not conn.get('enabled',True): raise HTTPException(409,'This API connection is disabled')
    payload,status=await fetch_connection(conn)
    if payload is None: raise HTTPException(502,detail={'message':'Fleet API request failed','status':status})
    groups=latest_by_vehicle(payload,conn); rows=groups.get(req.external_vehicle_id)
    if not rows: raise HTTPException(404,f'Vehicle {req.external_vehicle_id} was not found in this API response')
    current=rows[-1]; previous=rows[-2] if len(rows)>1 else None
    internal=safe_external_vehicle_id(req.connection_id,req.external_vehicle_id)
    fallback=store.get_live(cid,internal,'source_point')
    same_source=bool(fallback and abs(float(fallback.get('timestamp_epoch',-1))-float(current['timestamp_epoch']))<0.001)
    telemetry=telemetry_from_points(current,previous,fallback)
    gps={'lat':current['lat'],'lon':current['lon'],'speed_kmh':current['speed_kmh'],'heading_deg':current.get('heading_deg'),'timestamp':current['timestamp']}
    context=build_context(conn)
    store.set_live(cid,internal,'telemetry',Telemetry.model_validate(telemetry).model_dump())
    store.set_live(cid,internal,'gps',GPSPoint.model_validate(gps).model_dump())
    if not same_source: store.add_gps(cid,internal,GPSPoint.model_validate(gps).model_dump())
    store.set_live(cid,internal,'context',Context.model_validate(context).model_dump())
    point_to_store={k:v for k,v in current.items() if k!='raw'}; point_to_store['derived_accel_mps2']=telemetry['mean_deceleration_mps2']
    store.set_live(cid,internal,'source_point',point_to_store)
    raw_api={'connection_id':req.connection_id,'connection_name':conn.get('name'),'external_vehicle_id':req.external_vehicle_id,'source_record':current['raw'],'status':status,'stale':same_source}
    store.set_live(cid,internal,'raw_api',raw_api)
    store.save_fleet_vehicle(cid,internal,{
        'connection_id':req.connection_id,'connection_name':conn.get('name'),'external_vehicle_id':req.external_vehicle_id,
        'lat':current['lat'],'lon':current['lon'],'speed_kmh':current['speed_kmh'],'heading_deg':current.get('heading_deg'),
        'source_timestamp':current['timestamp'],'status':'online','last_poll_at':utcnow_iso()
    })
    out=infer_and_store(cid,internal,req.model,req.mode)
    out['fleet_api']={'connection_id':req.connection_id,'connection_name':conn.get('name'),'external_vehicle_id':req.external_vehicle_id,
                         'internal_vehicle_id':internal,'status':status,'stale':same_source,'poll_interval_sec':conn.get('poll_interval_sec',5)}
    out['raw_api_output']=current['raw']
    store.set_live(cid,internal,'inference',out)
    return out


# Serve the dashboard from the same Render service after all /api routes are registered.
from fastapi.staticfiles import StaticFiles
from .config import PUBLIC_DIR
if PUBLIC_DIR.exists():
    app.mount('/', StaticFiles(directory=str(PUBLIC_DIR), html=True), name='dashboard')
