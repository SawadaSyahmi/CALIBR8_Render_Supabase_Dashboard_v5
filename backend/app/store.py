from __future__ import annotations
from datetime import datetime, timezone
import math, uuid
from typing import Any
import httpx
from .config import settings


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def haversine_km(lat1, lon1, lat2, lon2):
    r=6371.0088
    p1,p2=math.radians(lat1),math.radians(lat2)
    dphi=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dphi/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(min(1,math.sqrt(a)))


class SupabaseStore:
    def __init__(self):
        self.base=settings.supabase_url
        self.key=settings.supabase_service_role_key

    def _check(self):
        if not self.base or not self.key:
            raise RuntimeError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

    def _headers(self, prefer: str | None=None):
        self._check()
        h={'apikey':self.key,'Authorization':f'Bearer {self.key}','Content-Type':'application/json'}
        if prefer: h['Prefer']=prefer
        return h

    def _request(self, method:str, table:str, *, params:dict|None=None, body:Any=None, prefer:str|None=None):
        url=f'{self.base}/rest/v1/{table}'
        with httpx.Client(timeout=12.0) as client:
            r=client.request(method,url,params=params,json=body,headers=self._headers(prefer))
        if r.status_code >= 400:
            raise RuntimeError(f'Supabase {table} {method} failed: {r.status_code} {r.text[:300]}')
        if not r.content:
            return None
        try: return r.json()
        except Exception: return None

    def _select(self,table:str,params:dict|None=None)->list[dict]:
        p={'select':'*'}
        if params: p.update(params)
        out=self._request('GET',table,params=p)
        return out or []

    def _upsert(self,table:str,body:dict,on_conflict:str):
        rows=self._request('POST',table,params={'on_conflict':on_conflict},body=body,prefer='resolution=merge-duplicates,return=representation')
        return (rows or [body])[0]

    def _insert(self,table:str,body:dict):
        rows=self._request('POST',table,body=body,prefer='return=representation')
        return (rows or [body])[0]

    def ensure_customer(self, customer_id:str='main', email:str|None=None):
        data={'workspace_id':settings.workspace_id,'updated_at':utcnow_iso()}
        if email: data['email']=email
        existing=self._select('workspace',{'workspace_id':f'eq.{settings.workspace_id}','limit':'1'})
        if not existing: data['created_at']=utcnow_iso()
        self._upsert('workspace',data,'workspace_id')

    def ensure_trip(self, customer_id:str, vehicle_id:str)->dict:
        live=self.get_live(customer_id,vehicle_id,'trip')
        if live and live.get('active_trip_id'):
            return live
        trip_id='trip_'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'_'+uuid.uuid4().hex[:8]
        data={'active_trip_id':trip_id,'distance_km':0.0,'harsh_events':0,'route_points':0,'started_at':utcnow_iso(),'updated_at':utcnow_iso(),'demo_step':0,'last_lat':None,'last_lon':None}
        self.set_live(customer_id,vehicle_id,'trip',data)
        self._upsert('trips',{'trip_id':trip_id,'vehicle_id':vehicle_id,'data':data,'updated_at':data['updated_at']},'trip_id')
        return data

    def reset_trip(self,customer_id:str,vehicle_id:str)->dict:
        trip_id='trip_'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        data={'active_trip_id':trip_id,'distance_km':0.0,'harsh_events':0,'route_points':0,'started_at':utcnow_iso(),'updated_at':utcnow_iso(),'demo_step':0,'last_lat':None,'last_lon':None}
        self.set_live(customer_id,vehicle_id,'trip',data)
        self._upsert('trips',{'trip_id':trip_id,'vehicle_id':vehicle_id,'data':data,'updated_at':data['updated_at']},'trip_id')
        return data

    def set_live(self,customer_id:str,vehicle_id:str,kind:str,data:dict):
        payload=dict(data); payload['server_updated_at']=utcnow_iso()
        row={'vehicle_id':vehicle_id,'kind':kind,'data':payload,'server_updated_at':payload['server_updated_at']}
        self._upsert('live_state',row,'vehicle_id,kind')
        return payload

    def get_live(self,customer_id:str,vehicle_id:str,kind:str)->dict|None:
        rows=self._select('live_state',{'vehicle_id':f'eq.{vehicle_id}','kind':f'eq.{kind}','limit':'1'})
        return rows[0].get('data') if rows else None

    def get_dashboard_live(self,customer_id:str,vehicle_id:str)->dict:
        rows=self._select('live_state',{'vehicle_id':f'eq.{vehicle_id}'})
        allowed={'telemetry','gps','context','trip','inference','raw_api'}
        return {r['kind']:r.get('data') or {} for r in rows if r.get('kind') in allowed}

    def list_route_points(self,customer_id:str,vehicle_id:str,trip_id:str,limit:int=500)->list[dict]:
        rows=self._select('route_points',{'vehicle_id':f'eq.{vehicle_id}','trip_id':f'eq.{trip_id}',
                                        'order':'server_updated_at.desc,id.desc','limit':str(limit)})
        return [{**(r.get('data') or {}),'id':r['id']} for r in reversed(rows)]

    def add_gps(self,customer_id:str,vehicle_id:str,gps:dict):
        trip=self.ensure_trip(customer_id,vehicle_id); trip_id=trip['active_trip_id']
        lat=float(gps['lat']); lon=float(gps['lon'])
        inc=0.0
        if trip.get('last_lat') is not None and trip.get('last_lon') is not None:
            inc=haversine_km(float(trip['last_lat']),float(trip['last_lon']),lat,lon)
            if inc>2.0: inc=0.0
        pid=f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}_{uuid.uuid4().hex[:6]}"
        point={**gps,'id':pid,'trip_id':trip_id,'server_updated_at':utcnow_iso()}
        updated={**trip,'distance_km':float(trip.get('distance_km',0))+inc,'route_points':int(trip.get('route_points',0))+1,'last_lat':lat,'last_lon':lon,'last_route_point':point,'updated_at':utcnow_iso()}
        self.set_live(customer_id,vehicle_id,'trip',updated)
        self._upsert('trips',{'trip_id':trip_id,'vehicle_id':vehicle_id,'data':updated,'updated_at':updated['updated_at']},'trip_id')
        self._insert('route_points',{'id':pid,'vehicle_id':vehicle_id,'trip_id':trip_id,'timestamp':gps.get('timestamp') or utcnow_iso(),'server_updated_at':point['server_updated_at'],'data':point})
        return updated

    def record_event(self,customer_id:str,vehicle_id:str,event_id:str,event:dict)->bool:
        existing=self._select('events',{'event_id':f'eq.{event_id}','limit':'1'})
        if existing: return False
        trip=self.ensure_trip(customer_id,vehicle_id); trip_id=trip['active_trip_id']
        payload=dict(event); payload['trip_id']=trip_id; payload['server_updated_at']=utcnow_iso()
        self._insert('events',{'event_id':event_id,'vehicle_id':vehicle_id,'trip_id':trip_id,'timestamp':payload.get('timestamp') or utcnow_iso(),'server_updated_at':payload['server_updated_at'],'data':payload})
        trip['harsh_events']=int(trip.get('harsh_events',0))+1; trip['updated_at']=utcnow_iso()
        self.set_live(customer_id,vehicle_id,'trip',trip)
        self._upsert('trips',{'trip_id':trip_id,'vehicle_id':vehicle_id,'data':trip,'updated_at':trip['updated_at']},'trip_id')
        return True

    def next_demo_step(self,customer_id:str,vehicle_id:str)->int:
        trip=self.ensure_trip(customer_id,vehicle_id)
        step=int(trip.get('demo_step',0))+1; trip['demo_step']=step; trip['updated_at']=utcnow_iso()
        self.set_live(customer_id,vehicle_id,'trip',trip)
        self._upsert('trips',{'trip_id':trip['active_trip_id'],'vehicle_id':vehicle_id,'data':trip,'updated_at':trip['updated_at']},'trip_id')
        return step

    def next_replay_step(self,customer_id:str,vehicle_id:str,scenario:str,harsh:bool=False)->int:
        data=self.get_live(customer_id,vehicle_id,'replay') or {}
        key=f"{scenario}_{'harsh' if harsh else 'normal'}"
        step=int(data.get(key,0)); data[key]=step+1; data['active_scenario']=scenario; data['harsh_mode']=bool(harsh); data['updated_at']=utcnow_iso()
        self.set_live(customer_id,vehicle_id,'replay',data)
        return step

    def reset_replay(self,customer_id:str,vehicle_id:str,scenario:str|None=None)->dict:
        data=self.get_live(customer_id,vehicle_id,'replay') or {}
        if scenario:
            data.update({f'{scenario}_normal':0,f'{scenario}_harsh':0,'active_scenario':scenario,'updated_at':utcnow_iso()})
        else:
            data={'route_1_normal':0,'route_1_harsh':0,'route_2_normal':0,'route_2_harsh':0,'route_3_normal':0,'route_3_harsh':0,'updated_at':utcnow_iso()}
        self.set_live(customer_id,vehicle_id,'replay',data)
        return data

    def list_events(self,customer_id:str,vehicle_id:str,trip_id:str,limit:int=1000)->list[dict]:
        rows=self._select('events',{'vehicle_id':f'eq.{vehicle_id}','trip_id':f'eq.{trip_id}','order':'timestamp.desc','limit':str(limit)})
        return [{**(r.get('data') or {}),'event_id':r['event_id']} for r in rows]

    def save_connection(self, customer_id:str, connection_id:str, data:dict)->dict:
        old=self.get_connection(customer_id,connection_id) or {}
        payload={**old,**data,'connection_id':connection_id,'updated_at':utcnow_iso()}
        if not old: payload['created_at']=utcnow_iso()
        self._upsert('api_connections',{'connection_id':connection_id,'data':payload,'updated_at':payload['updated_at']},'connection_id')
        return payload

    def list_connections(self, customer_id:str)->list[dict]:
        rows=self._select('api_connections',{'order':'updated_at.desc'})
        return [r.get('data') or {} for r in rows]

    def get_connection(self, customer_id:str, connection_id:str)->dict|None:
        rows=self._select('api_connections',{'connection_id':f'eq.{connection_id}','limit':'1'})
        return rows[0].get('data') if rows else None

    def delete_connection(self, customer_id:str, connection_id:str):
        self._request('DELETE','api_connections',params={'connection_id':f'eq.{connection_id}'},prefer='return=minimal')

    def save_fleet_vehicle(self, customer_id:str, internal_vehicle_id:str, data:dict):
        payload={**data,'vehicle_id':internal_vehicle_id,'updated_at':utcnow_iso()}
        self._upsert('fleet',{'vehicle_id':internal_vehicle_id,'data':payload,'updated_at':payload['updated_at']},'vehicle_id')
        return payload

    def list_fleet(self, customer_id:str)->list[dict]:
        rows=self._select('fleet',{'order':'updated_at.desc'})
        return [r.get('data') or {} for r in rows]
