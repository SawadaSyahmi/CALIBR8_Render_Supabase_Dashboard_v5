import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CALIBR8_CONFIG } from './calibr8-config.js';

const clientConfigResponse = await fetch('/api/client-config', {cache:'no-store'});
if (!clientConfigResponse.ok) throw new Error('Supabase client configuration is missing on the Render service.');
const clientConfig = await clientConfigResponse.json();
const supabase = createClient(clientConfig.supabase_url, clientConfig.supabase_anon_key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const state={telemetry:null,gps:null,context:null,inference:null,trip:null,route:[],events:[],replay:null,rawApi:null,lastHarshReplay:null,connections:[],fleet:[]};
let selectedModel='new_ai', mode='balanced', sourceMode=CALIBR8_CONFIG.defaultSource||'fleet_api', selectedScenario='route_1';
let selectedVehicleId=CALIBR8_CONFIG.vehicleId||'demo_vehicle', selectedConnectionId='', selectedExternalVehicleId='';
let map,routeLine,carMarker,routeUnsub,eventUnsub,timer=null,inferenceTimer=null,lastInferenceKey='',tripUnsub=null;
let telemetryChart=null;
let liveUnsubs=[];let isPlaying=false,playbackSpeed=5,compressGaps=true,nextTickAt=null,tickInFlight=false,initialized=false;
let user=null,session=null;
let sourceRevision=0;
let authSignal=0,authRevision=0,workspaceOwnerId=null,workspaceInitTimer=null,workspaceLoad=null,authBusy=false;
let viewGeneration=0,snapshotTimer=null,snapshotInFlight=false,lastDataAt=0,lastChartKey='';
const liveVersions=new Map();
const harshMarkers=[],labels=[],speeds=[],decels=[];
const $=id=>document.getElementById(id);
const fmt=(v,n=2)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v).toFixed(n):'—';
const pretty=s=>String(s??'—').replaceAll('_',' ');
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function configReady(){return Boolean(clientConfig.supabase_url&&clientConfig.supabase_anon_key);}
function initMap(){
  if(!window.L){$('map').innerHTML='<div class="map-unavailable"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15"/></svg><strong>Map is unavailable</strong><span>Location coordinates still update below. Check your internet connection to load the map.</span></div>';return;}
  map=L.map('map',{zoomControl:true}).setView([3.139,101.687],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  routeLine=L.polyline([],{color:'var(--route)',weight:3,opacity:.95}).addTo(map);
  carMarker=L.marker([3.139,101.687],{icon:L.divIcon({className:'',html:'<div class="car-pin"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 8 2-4h10l2 4M5 8h14a2 2 0 0 1 2 2v7H3v-7a2 2 0 0 1 2-2ZM3 17v3h4v-3m10 0v3h4v-3M6 12h2m8 0h2"/></svg></div>',iconSize:[34,34],iconAnchor:[17,17]})});
}
function chartPalette(){const css=getComputedStyle(document.documentElement);return {text:css.getPropertyValue('--muted').trim()||'#9aa9bc',grid:css.getPropertyValue('--chart-grid').trim()||'#293444',speed:css.getPropertyValue('--chart-speed').trim()||'#52d8bd',decel:css.getPropertyValue('--chart-decel').trim()||'#f2b76b'};}
function applyChartTheme(){
  if(!window.Chart)return;const colors=chartPalette();Chart.defaults.color=colors.text;Chart.defaults.borderColor=colors.grid;
  const chart=telemetryChart;if(!chart)return;
  chart.data.datasets[0].borderColor=colors.speed;chart.data.datasets[1].borderColor=colors.decel;
  for(const axis of Object.values(chart.options.scales)){axis.ticks={...axis.ticks,color:colors.text};axis.title={...axis.title,color:colors.text};axis.grid={...axis.grid,color:colors.grid};}
  chart.options.plugins.legend.labels.color=colors.text;chart.update('none');
}
function initChart(){
  if(!window.Chart)return;const colors=chartPalette();Chart.defaults.color=colors.text;Chart.defaults.borderColor=colors.grid;
  telemetryChart=new Chart($('telemetryChart'),{type:'line',data:{labels,datasets:[{label:'Speed (km/h)',data:speeds,borderColor:colors.speed,borderWidth:2,pointRadius:0,pointHitRadius:10,tension:.25,yAxisID:'y'},{label:'Peak decel. (m/s²)',data:decels,borderColor:colors.decel,borderWidth:2,pointRadius:0,pointHitRadius:10,tension:.25,yAxisID:'y1'}]},options:{responsive:true,animation:false,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top',align:'end',labels:{boxWidth:12,boxHeight:3,padding:17,font:{size:9},color:colors.text}}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:7,maxRotation:0,font:{size:9},color:colors.text}},y:{beginAtZero:true,border:{display:false},grid:{color:colors.grid},ticks:{maxTicksLimit:5,font:{size:9},color:colors.text},title:{display:true,text:'km/h',font:{size:9},color:colors.text}},y1:{beginAtZero:true,position:'right',border:{display:false},grid:{drawOnChartArea:false},ticks:{maxTicksLimit:5,font:{size:9},color:colors.text},title:{display:true,text:'m/s²',font:{size:9},color:colors.text}}}}});
}
document.addEventListener('calibr8:themechange',applyChartTheme);
document.addEventListener('calibr8:viewchange',()=>{if(window.CALIBR8_UI?.view==='overview'){setTimeout(()=>{map?.invalidateSize();telemetryChart?.resize?.();},0);}});
function updateWorkspaceSummary(){
  $('activeModelLabel').textContent=selectedModel==='friend_gbm'?'Friend GBM · 4 classes':`CALIBR8-AI · ${mode==='safety'?'Safety':'Balanced'}`;
  document.querySelector('.source-panel').dataset.source=sourceMode;
  const labels={fleet_api:selectedExternalVehicleId?`Monitoring ${selectedExternalVehicleId} · ${state.connections.find(c=>c.connection_id===selectedConnectionId)?.name||'Connected fleet API'}`:'Connect a fleet API, then choose a vehicle to monitor.',replay:'Recorded sample route · not a live vehicle feed',harsh_replay:'Recorded sample with a controlled braking event',demo:'Synthetic demonstration · simulated vehicle readings',external:'Vehicle data from the configured external APIs',push:'Waiting for device / API push updates'};
  $('sourceCaption').textContent=sourceMode==='push'&&state.telemetry?'Receiving device / API push updates':labels[sourceMode]||'Choose a data source to begin.';
  $('runSampleBtn').classList.toggle('hidden',isReplayMode());
  if(sourceMode==='fleet_api'&&!selectedExternalVehicleId)$('sourceCaption').textContent='No live vehicle selected. Connect an API or run a sample replay.';
  $('fleetUnavailable').classList.toggle('hidden',sourceMode==='fleet_api');
  document.querySelector('.events-metric')?.classList.toggle('has-events',Number(state.trip?.harsh_events||0)>0);
  document.querySelectorAll('.seg').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.model===selectedModel)));
}
function setApiStatus(key,message,badge='live',bad=false){const ids={telemetry:['telemetryStatus','telemetryLatency'],gps:['gpsStatus','gpsLatency'],context:['contextStatus','contextLatency'],inference:['inferenceStatus','inferenceLatency']}[key];if(!ids)return;$(ids[0]).textContent=message;$(ids[1]).textContent=badge;$(ids[0]).closest('.api-card')?.classList.toggle('bad',bad);}
function updateGauge(prob,harsh){const pct=Math.max(0,Math.min(100,Number(prob||0)*100));$('riskPct').textContent=`${pct.toFixed(1)}%`;const arc=$('gaugeArc');arc.style.strokeDasharray=`${pct} ${100-pct}`;arc.style.stroke=harsh?'var(--danger)':(pct>45?'var(--warning)':'var(--positive)');$('decisionBadge').textContent=harsh?'HARSH / SEVERE':'NORMAL / MILD';$('decisionBadge').className=`decision ${harsh?'harsh':'safe'}`;}
function resetVehicleView(){
  state.telemetry=state.gps=state.context=state.inference=state.trip=null;
  state.rawApi=state.replay=state.lastHarshReplay=null;state.route=[];state.events=[];
  lastChartKey=lastInferenceKey='';lastDataAt=0;liveVersions.clear();
  labels.splice(0);speeds.splice(0);decels.splice(0);telemetryChart?.update('none');
  routeLine?.setLatLngs([]);while(harshMarkers.length)map?.removeLayer(harshMarkers.pop());
  updateGauge(0,false);$('riskPct').textContent='—';$('decisionBadge').textContent='WAITING';
  $('modelName').textContent=selectedModel==='friend_gbm'?'Friend GBM':'CALIBR8-AI';
  $('decisionText').textContent='Waiting for vehicle measurements.';
  render();
}
function updateRoute(){const gps=state.gps||{},route=state.route||[],events=state.events||[];$('coords').textContent=`GPS: ${fmt(gps.lat,5)}, ${fmt(gps.lon,5)}`;$('routeInfo').textContent=`${route.length} route points`;if(!map||!window.L||gps.lat==null||gps.lon==null)return;const pts=route.filter(p=>p.lat!=null&&p.lon!=null).map(p=>[p.lat,p.lon]);routeLine.setLatLngs(pts);carMarker.setLatLng([gps.lat,gps.lon]);if(!map.hasLayer(carMarker))carMarker.addTo(map);if(pts.length===1)map.setView(pts[0],16);else if(pts.length===2)map.fitBounds(routeLine.getBounds(),{padding:[30,30]});while(harshMarkers.length)map.removeLayer(harshMarkers.pop());events.slice().reverse().forEach(e=>{if(e.lat==null||e.lon==null)return;const m=L.circleMarker([e.lat,e.lon],{radius:6,color:'var(--panel)',weight:2,fillColor:'var(--danger)',fillOpacity:.9}).bindPopup(`<b>Harsh braking</b><br>${Math.round((e.probability||0)*100)}% • ${fmt(e.speed_kmh,1)} km/h<br>${pretty(e.physics_label)}`).addTo(map);harshMarkers.push(m);});}
function updateEvents(){
  const all=state.events||[],query=($('eventSearch')?.value||'').trim().toLowerCase();
  const events=all.filter(e=>!query||[new Date(e.timestamp).toLocaleString(),e.model,e.model_key,pretty(e.physics_label),e.lat,e.lon].join(' ').toLowerCase().includes(query));
  $('eventCountLabel').textContent=query?`${events.length} of ${all.length} events`:`${all.length} event${all.length===1?'':'s'}`;
  if(!events.length){$('eventRows').innerHTML=`<tr><td colspan="7" class="empty">${query?'No events match your search.':'No harsh-braking events recorded for this trip.'}</td></tr>`;return;}
  $('eventRows').innerHTML=events.map(e=>`<tr><td>${esc(new Date(e.timestamp).toLocaleTimeString())}</td><td>${e.model_key==='friend_gbm'?'Friend GBM':'CALIBR8-AI'}</td><td><span class="probability-chip">${fmt((e.probability||0)*100,1)}%</span></td><td>${fmt(e.speed_kmh,1)} km/h</td><td>${fmt(e.peak_decel_mps2,2)} m/s²</td><td>${esc(pretty(e.physics_label))} · ${fmt((e.utilisation||0)*100,0)}%</td><td>${fmt(e.lat,5)}, ${fmt(e.lon,5)}</td></tr>`).join('');
}
function updateChart(){
  const t=state.telemetry;if(!t)return;
  const key=[t.timestamp_start,t.pre_event_speed_kmh,t.post_event_speed_kmh,t.peak_deceleration_mps2].join('|');
  if(key===lastChartKey)return;lastChartKey=key;
  labels.push(new Date(t.timestamp_start||Date.now()).toLocaleTimeString([],{minute:'2-digit',second:'2-digit'}));
  speeds.push(Number(t.post_event_speed_kmh??state.gps?.speed_kmh??t.pre_event_speed_kmh??0));
  decels.push(Math.abs(Number(t.peak_deceleration_mps2||0)));
  if(labels.length>60){labels.shift();speeds.shift();decels.shift();}telemetryChart?.update('none');
}
function renderSourcePayload(){updateWorkspaceSummary();const r=state.replay||{},raw=state.rawApi||{};if(sourceMode==='fleet_api'){$('replayBadge').textContent=selectedConnectionId?'fleet live':'waiting';$('replayDevice').textContent=selectedExternalVehicleId||'—';$('replayPoint').textContent='live';$('replayDelta').textContent='provider';$('replayAccel').textContent=state.telemetry?.mean_deceleration_mps2!=null?`${fmt(state.telemetry.mean_deceleration_mps2,3)} m/s²`:'—';$('apiOutput').textContent=state.rawApi?JSON.stringify(state.rawApi,null,2):'Waiting for selected fleet API…';return;}$('replayBadge').textContent=r.scenarioName?`${r.scenarioName} • ${r.index+1}/${r.totalPoints}`:'waiting';$('replayDevice').textContent=r.deviceId||raw.deviceId||'—';$('replayPoint').textContent=r.totalPoints!=null?`${(r.index||0)+1} / ${r.totalPoints}`:'—';$('replayDelta').textContent=r.sourceDeltaSec!=null?`${fmt(r.sourceDeltaSec,1)} s`:'—';$('replayAccel').textContent=r.derivedLongitudinalAccelMps2!=null?`${fmt(r.derivedLongitudinalAccelMps2,3)} m/s²`:'—';$('apiOutput').textContent=state.rawApi?JSON.stringify(state.rawApi,null,2):'Waiting for replay data…';const h=state.lastHarshReplay;if(h){$('harshReplayBadge').textContent='HARSH EVENT';$('harshOutput').className='harsh-event-box';$('harshOutput').innerHTML=`<h4>Controlled harsh-braking event injected</h4><div class="harsh-event-grid"><div><span>Pre speed</span><strong>${fmt(h.preSpeedKmh,1)} km/h</strong></div><div><span>Post speed</span><strong>${fmt(h.postSpeedKmh,1)} km/h</strong></div><div><span>Speed drop</span><strong>${fmt(h.speedDropKmh,1)} km/h</strong></div><div><span>Peak decel.</span><strong>${fmt(h.peakDecelerationMps2,2)} m/s²</strong></div><div><span>Jerk</span><strong>${fmt(h.maxJerkMps3,1)} m/s³</strong></div><div><span>Duration</span><strong>${fmt(h.durationSec,2)} s</strong></div></div>`;}else{$('harshReplayBadge').textContent=sourceMode==='harsh_replay'?'armed':'not active';$('harshOutput').className='harsh-output-empty';$('harshOutput').textContent=sourceMode==='harsh_replay'?'Harsh replay armed. A controlled event will be injected when the route reaches its test point.':'Choose “Replay + harsh event”. The route will play normally and inject one controlled harsh-braking event each cycle.';}}
function render(){const t=state.telemetry||{},c=state.context||{},pack=state.inference||{},p=pack.physics||{},i=pack.inference||{},comp=pack.model_comparison||{},trip=state.trip||{};if(i.model){updateGauge(i.probability_harsh,i.harsh_or_severe);$('modelName').textContent=i.model;$('decisionText').textContent=i.harsh_or_severe?'Harsh braking detected. Review the event and route location.':'No harsh/severe braking detected in the current event.';}$('newAiMini').textContent=comp.new_ai?`${fmt(comp.new_ai.probability_harsh*100,1)}%`:'—';$('friendMini').textContent=comp.friend_gbm?`${fmt(comp.friend_gbm.probability_harsh*100,1)}%`:'—';$('physicsMini').textContent=p.physics_label?pretty(p.physics_label):'—';$('speed').textContent=fmt(state.gps?.speed_kmh??t.post_event_speed_kmh??t.pre_event_speed_kmh,1);$('peak').textContent=fmt(t.peak_deceleration_mps2,2);$('jerk').textContent=fmt(t.max_jerk_mps3,2);$('util').textContent=p.utilisation!=null?fmt(p.utilisation*100,0):'—';$('distance').textContent=fmt(trip.distance_km,2);$('harshCount').textContent=trip.harsh_events??'—';$('mu').textContent=fmt(p.mu_est,3);$('angle').textContent=p.road_angle_deg!=null?`${fmt(p.road_angle_deg,2)}°`:'—';$('traction').textContent=p.a_traction_mps2!=null?`${fmt(p.a_traction_mps2,2)} m/s²`:'—';$('capability').textContent=p.a_capability_mps2!=null?`${fmt(p.a_capability_mps2,2)} m/s²`:'—';$('available').textContent=p.a_available_mps2!=null?`${fmt(p.a_available_mps2,2)} m/s²`:'—';$('brakeObs').textContent=p.observed_brake_component_mps2!=null?`${fmt(p.observed_brake_component_mps2,2)} m/s²`:'—';$('physicsLabel').textContent=p.physics_label?pretty(p.physics_label):'—';$('vehicle').textContent=pretty(c.vehicle_type);$('road').textContent=pretty(c.road_type);$('traffic').textContent=pretty(c.traffic_density);$('weather').textContent=pretty(c.weather);$('surface').textContent=pretty(c.road_surface);$('grade').textContent=c.road_grade_ratio!=null?`${fmt(c.road_grade_ratio*100,1)}%`:'—';$('qualityBadge').textContent=`GPS ${pretty(t.gps_quality)} • sensor ${pretty(t.sensor_quality)}`;if(i.components){$('submodelInfo').innerHTML=`XGBoost: <b>${fmt(i.components.xgboost_probability*100,1)}%</b> &nbsp; LightGBM: <b>${fmt(i.components.lightgbm_probability*100,1)}%</b><br>Ensemble: 60% XGBoost + 40% LightGBM • threshold ${fmt(i.threshold,3)}`;}else if(i.class_probabilities){const q=i.class_probabilities;$('submodelInfo').innerHTML=`Friend GBM 4-class probabilities — normal <b>${fmt((q.normal||0)*100,1)}%</b>, mild <b>${fmt((q.mild_braking||0)*100,1)}%</b>, harsh <b>${fmt((q.harsh_braking||0)*100,1)}%</b>, severe <b>${fmt((q.severe_braking||0)*100,1)}%</b>`;}renderSourcePayload();updateRoute();updateEvents();if(pack.server_time)$('updatedAt').textContent=`Updated ${new Date(pack.server_time).toLocaleString()}`;}

if(!configReady()){$('liveText').textContent='CONFIG NEEDED';$('authStatus').textContent='not configured';$('firestoreStatus').textContent='not configured';['telemetry','gps','context','inference'].forEach(k=>setApiStatus(k,'Configure Supabase environment variables on Render','setup',true));throw new Error('Supabase client configuration is unavailable');}
async function token(){const {data,error}=await supabase.auth.getSession();if(error||!data.session?.access_token)throw new Error('Not authenticated');return data.session.access_token;}
async function apiRequest(path,{method='GET',body}={}){const tok=await token();const t=performance.now();const opts={method,headers:{'Authorization':`Bearer ${tok}`},cache:'no-store'};if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}const r=await fetch(path,opts);const ms=performance.now()-t;let data=null;try{data=await r.json();}catch{}if(!r.ok)throw new Error(data?.detail?`${r.status} ${typeof data.detail==='string'?data.detail:JSON.stringify(data.detail)}`:`HTTP ${r.status}`);setApiStatus('inference','Render API connected',`${ms.toFixed(0)} ms`);return data;}
const apiPost=(p,b={})=>apiRequest(p,{method:'POST',body:b});const apiGet=p=>apiRequest(p);const apiDelete=p=>apiRequest(p,{method:'DELETE'});

function unsubscribeVehicle(){
  viewGeneration++;clearInterval(snapshotTimer);snapshotTimer=null;
  clearTimeout(inferenceTimer);inferenceTimer=null;
  for(const ch of [...liveUnsubs,routeUnsub,eventUnsub,tripUnsub]){if(ch)supabase.removeChannel(ch);}
  liveUnsubs=[];routeUnsub=eventUnsub=tripUnsub=null;
}
function acceptLiveValue(kind,data){
  const stamp=data?.server_updated_at||(kind==='inference'?data?.server_time:data?.updated_at);
  const previous=liveVersions.get(kind);
  if(stamp&&previous&&Date.parse(stamp)<Date.parse(previous))return false;
  if(stamp)liveVersions.set(kind,stamp);
  return true;
}
function addRoutePoint(point){
  if(!point||point.lat==null||point.lon==null)return;
  if(point.trip_id&&point.trip_id!==state.trip?.active_trip_id)return;
  const key=p=>p.id||[p.timestamp,p.lat,p.lon].join('|');
  const index=state.route.findIndex(p=>key(p)===key(point));
  if(index<0)state.route.push(point);else state.route[index]=point;
  state.route.sort((a,b)=>String(a.server_updated_at||a.timestamp||'').localeCompare(String(b.server_updated_at||b.timestamp||'')));
  state.route=state.route.slice(-500);
}
function addEvent(event){
  if(!event||!event.event_id)return;
  if(event.trip_id&&event.trip_id!==state.trip?.active_trip_id)return;
  const index=state.events.findIndex(e=>e.event_id===event.event_id);
  if(index<0)state.events.push(event);else state.events[index]=event;
  state.events.sort((a,b)=>String(b.timestamp||'').localeCompare(String(a.timestamp||'')));
  state.events=state.events.slice(0,50);
}
function applyTrip(trip){
  if(!trip||!acceptLiveValue('trip',trip))return;
  const changed=trip.active_trip_id!==state.trip?.active_trip_id;
  state.trip=trip;
  if(changed){state.route=[];state.events=[];attachTripListeners(trip.active_trip_id);}
  addRoutePoint(trip.last_route_point);
}
function applyDashboardPayload(out){
  if(!out||!user||out.vehicle_id!==selectedVehicleId)return;
  // Each tick/inference response is sufficient even when Realtime is unavailable.
  for(const kind of ['telemetry','gps','context']){
    const data=out[kind]||(kind==='telemetry'?out.input:null);
    if(data&&acceptLiveValue(kind,data))state[kind]=data;
  }
  applyTrip(out.trip);addRoutePoint(out.route_point);addEvent(out.event);
  if(out.inference&&(!out.selected_model||out.selected_model===selectedModel)&&(!out.selected_mode||out.selected_mode===mode)&&acceptLiveValue('inference',out))state.inference=out;
  if(out.raw_api_output)state.rawApi=out.raw_api_output;
  if(out.replay)state.replay=out.replay;
  if(out.harsh_event)state.lastHarshReplay=out.harsh_event;
  lastDataAt=Date.now();$('firestoreStatus').textContent='Live API updates';
  if(state.telemetry)setApiStatus('telemetry','Vehicle measurements received','live');
  if(state.gps)setApiStatus('gps','Vehicle position received','live');
  if(state.context)setApiStatus('context','Driving context received','ready');
  updateChart();render();
}
function applyLiveRow(row){
  if(!user||!row||row.vehicle_id!==selectedVehicleId)return;
  const kind=row.kind,data=row.data||{};
  if(kind==='inference'){applyDashboardPayload({...data,vehicle_id:row.vehicle_id});return;}
  if(!acceptLiveValue(kind,data))return;
  if(['telemetry','gps','context'].includes(kind)){
    state[kind]=data;setApiStatus(kind,'Vehicle data received','live');
    updateChart();requestInferenceSoon();
  }else if(kind==='raw_api'){state.rawApi=data;}
  else if(kind==='trip'){applyTrip(data);}
  render();
}
async function refreshDashboardSnapshot(){
  if(!user||snapshotInFlight)return;
  const vehicle=selectedVehicleId,generation=viewGeneration,startedAt=lastDataAt;
  snapshotInFlight=true;
  try{
    const out=await apiGet(`/api/state?vehicle_id=${encodeURIComponent(vehicle)}`);
    if(!user||generation!==viewGeneration||vehicle!==selectedVehicleId)return;
    // A newer tick may have completed while this initial/history read was in flight.
    const live=out.live||{};
    if(startedAt!==lastDataAt){
      if(live.trip?.active_trip_id===state.trip?.active_trip_id){
        for(const point of out.route_points||[])addRoutePoint(point);
        for(const event of out.events||[])addEvent(event);
        updateRoute();updateEvents();
      }
      return;
    }
    for(const kind of ['telemetry','gps','context','raw_api','trip']){
      if(live[kind])applyLiveRow({vehicle_id:vehicle,kind,data:live[kind]});
    }
    const pack=live.inference;
    // A reset leaves the previous inference row in storage. Ignore its old trip.
    if(pack&&(!pack.trip?.active_trip_id||pack.trip.active_trip_id===state.trip?.active_trip_id))applyDashboardPayload({...pack,trip:live.trip||pack.trip,vehicle_id:vehicle});
    for(const point of out.route_points||[])addRoutePoint(point);
    for(const event of out.events||[])addEvent(event);
    $('firestoreStatus').textContent='Live API updates';updateChart();render();
    if(sourceMode==='push')requestInferenceSoon();
  }catch(e){
    if(generation===viewGeneration){$('firestoreStatus').textContent='Retrying live updates';console.warn(e);}
  }finally{snapshotInFlight=false;}
}
function attachTripListeners(tripId){
  for(const ch of [routeUnsub,eventUnsub])if(ch)supabase.removeChannel(ch);
  routeUnsub=eventUnsub=null;if(!tripId||!user)return;
  const generation=viewGeneration,vehicle=selectedVehicleId;
  const current=()=>user&&generation===viewGeneration&&vehicle===selectedVehicleId&&tripId===state.trip?.active_trip_id;
  routeUnsub=supabase.channel(`route-${vehicle}-${tripId}-${Date.now()}`).on('postgres_changes',{event:'INSERT',schema:'public',table:'route_points',filter:`trip_id=eq.${tripId}`},payload=>{
    if(!current()||payload.new.vehicle_id!==vehicle)return;
    addRoutePoint({...payload.new.data,id:payload.new.id});updateRoute();
  }).subscribe();
  eventUnsub=supabase.channel(`events-${vehicle}-${tripId}-${Date.now()}`).on('postgres_changes',{event:'INSERT',schema:'public',table:'events',filter:`trip_id=eq.${tripId}`},payload=>{
    if(!current()||payload.new.vehicle_id!==vehicle)return;
    addEvent({...payload.new.data,event_id:payload.new.event_id});updateEvents();updateRoute();
  }).subscribe();
}
function attachLiveListeners(){
  unsubscribeVehicle();resetVehicleView();if(!user||!selectedVehicleId)return;
  const vehicle=selectedVehicleId,generation=viewGeneration;
  const ch=supabase.channel(`live-${vehicle}-${Date.now()}`).on('postgres_changes',{event:'*',schema:'public',table:'live_state',filter:`vehicle_id=eq.${vehicle}`},payload=>{
    if(generation===viewGeneration)applyLiveRow(payload.new);
  }).subscribe(status=>{
    if(generation!==viewGeneration)return;
    $('firestoreStatus').textContent=status==='SUBSCRIBED'?'Live updates connected':'Live API updates';
  });
  liveUnsubs.push(ch);refreshDashboardSnapshot();
  snapshotTimer=setInterval(()=>{
    if(sourceMode==='push'||Date.now()-lastDataAt>5000)refreshDashboardSnapshot();
  },5000);
}
function requestInferenceSoon(){clearTimeout(inferenceTimer);inferenceTimer=setTimeout(async()=>{if(sourceMode!=='push'||!state.telemetry||!state.gps||!state.context)return;const generation=viewGeneration;const key=[state.telemetry.server_updated_at,state.gps.server_updated_at,state.context.server_updated_at,selectedModel,mode,selectedVehicleId].join('|');if(key===lastInferenceKey)return;try{const out=await apiPost('/api/inference',{vehicle_id:selectedVehicleId,model:selectedModel,mode});if(generation===viewGeneration){applyDashboardPayload(out);lastInferenceKey=key;}}catch(e){setApiStatus('inference',e.message,'error',true);}},250);}

// Fleet API connection management ---------------------------------------------------
function sessionIsCurrent(revision,ownerId){return revision===authRevision&&Boolean(ownerId)&&user?.id===ownerId;}
async function loadConnections(){const revision=authRevision,ownerId=user?.id;const out=await apiGet('/api/connections');if(!sessionIsCurrent(revision,ownerId))return [];state.connections=out.connections||[];renderConnections();populateConnectionFilter();return state.connections;}
function populateConnectionFilter(){const sel=$('fleetConnectionSelect'),current=sel.value||'all';sel.innerHTML='<option value="all">All connections</option>'+state.connections.map(c=>`<option value="${esc(c.connection_id)}">${esc(c.name)}</option>`).join('');sel.value=[...sel.options].some(o=>o.value===current)?current:'all';renderFleet();}
function renderConnections(){const root=$('connectionsList');if(!state.connections.length){root.innerHTML='<div class="empty-fleet">No live APIs saved yet. Add the first connection below.</div>';return;}root.innerHTML=state.connections.map(c=>`<div class="connection-row"><div class="meta"><strong>${esc(c.name)}</strong><span>${c.enabled?'Enabled':'Disabled'} • ${c.has_headers?'secured headers':'no headers'}</span></div><div class="meta"><span>${esc(c.url)}</span><span>${esc(c.field_mapping?.device_id||'deviceId')} • ${esc(c.field_mapping?.latitude||'latitude')}/${esc(c.field_mapping?.longitude||'longitude')} • every ${c.poll_interval_sec||5}s</span></div><div class="connection-row-actions"><button class="button small ghost" data-test-conn="${esc(c.connection_id)}">Test</button><button class="button small ghost" data-edit-conn="${esc(c.connection_id)}">Edit</button><button class="button small danger" data-delete-conn="${esc(c.connection_id)}">Delete</button></div></div>`).join('');root.querySelectorAll('[data-test-conn]').forEach(b=>b.addEventListener('click',()=>testConnection(b.dataset.testConn)));root.querySelectorAll('[data-edit-conn]').forEach(b=>b.addEventListener('click',()=>editConnection(b.dataset.editConn)));root.querySelectorAll('[data-delete-conn]').forEach(b=>b.addEventListener('click',()=>deleteConnection(b.dataset.deleteConn)));}
function clearConnectionForm(){$('connectionForm').reset();$('connectionId').value='';$('mapDevice').value='deviceId';$('mapTimestamp').value='dateTime';$('mapLat').value='latitude';$('mapLon').value='longitude';$('mapSpeed').value='speed';$('mapDirection').value='direction';$('timestampFormat').value='epoch_seconds';$('speedUnit').value='kmh';$('pollInterval').value='5';$('ctxVehicle').value='passenger_car';$('ctxRoad').value='urban';$('ctxTraffic').value='medium';$('ctxWeather').value='clear';$('ctxSurface').value='dry_asphalt';$('ctxGrade').value='0';$('connectionEnabled').checked=true;$('connectionFormStatus').textContent='';}
function editConnection(id){const c=state.connections.find(x=>x.connection_id===id);if(!c)return;$('connectionId').value=c.connection_id;$('connectionName').value=c.name||'';$('connectionUrl').value=c.url||'';$('connectionHeaders').value='';$('rootPath').value=c.root_path||'';$('mapDevice').value=c.field_mapping?.device_id||'deviceId';$('mapTimestamp').value=c.field_mapping?.timestamp||'dateTime';$('mapLat').value=c.field_mapping?.latitude||'latitude';$('mapLon').value=c.field_mapping?.longitude||'longitude';$('mapSpeed').value=c.field_mapping?.speed||'speed';$('mapDirection').value=c.field_mapping?.direction||'direction';$('timestampFormat').value=c.timestamp_format||'epoch_seconds';$('speedUnit').value=c.speed_unit||'kmh';$('pollInterval').value=String(c.poll_interval_sec||5);$('ctxVehicle').value=c.default_context?.vehicle_type||'passenger_car';$('ctxRoad').value=c.default_context?.road_type||'urban';$('ctxTraffic').value=c.default_context?.traffic_density||'medium';$('ctxWeather').value=c.default_context?.weather||'clear';$('ctxSurface').value=c.default_context?.road_surface||'dry_asphalt';$('ctxGrade').value=String(Number(c.default_context?.road_grade_ratio||0)*100);$('connectionEnabled').checked=c.enabled!==false;$('connectionFormStatus').textContent=c.has_headers?'Stored headers are encrypted. Leave headers blank to keep them.':'';$('connectionName').focus();}
async function testConnection(id){const el=$('connectionFormStatus');el.className='form-status';el.textContent='Testing connection…';try{const out=await apiPost(`/api/connections/${encodeURIComponent(id)}/test`,{});el.className=`form-status ${out.ok?'success':'error'}`;el.textContent=out.ok?`Connected. Found ${out.vehicles.length} vehicle(s) in ${out.status?.latency_ms??'—'} ms.`:`Connection failed: ${out.status?.message||'unknown error'}`;if(out.vehicles?.length){await refreshFleet(false);}}catch(e){el.className='form-status error';el.textContent=e.message;}}
async function deleteConnection(id){if(!confirm('Delete this API connection? Stored routes and events are not deleted.'))return;await apiDelete(`/api/connections/${encodeURIComponent(id)}`);if(selectedConnectionId===id){selectedConnectionId='';selectedExternalVehicleId='';}await loadConnections();await refreshFleet(false);}
async function refreshFleet(fetchRemote=true){
  const revision=authRevision,ownerId=user?.id,sourceAtRequest=sourceRevision;$('fleetSummary').textContent='Refreshing…';
  try{
    const out=fetchRemote?await apiPost('/api/fleet/discover',{}):await apiGet('/api/fleet');
    if(!sessionIsCurrent(revision,ownerId))return;
    state.fleet=out.vehicles||[];renderFleet();populateVehicleSelect();
    $('fleetSummary').textContent=`${state.connections.length} API${state.connections.length===1?'':'s'} • ${state.fleet.length} vehicle${state.fleet.length===1?'':'s'}`;
    if(sourceAtRequest===sourceRevision&&sourceMode==='fleet_api'&&!selectedExternalVehicleId&&state.fleet.length)selectFleetVehicle(state.fleet[0]);
  }catch(e){if(sessionIsCurrent(revision,ownerId))$('fleetSummary').textContent=`Fleet refresh error: ${e.message}`;}
}
function filteredFleet(){const f=$('fleetConnectionSelect').value||'all';return state.fleet.filter(v=>f==='all'||v.connection_id===f);}
function renderFleet(){
  if(!$('fleetGrid'))return;$('fleetCount').textContent=state.fleet.length;
  const query=($('fleetSearch')?.value||'').trim().toLowerCase();
  const rows=filteredFleet().filter(v=>!query||[v.external_vehicle_id,v.connection_name].join(' ').toLowerCase().includes(query));
  if(!rows.length){$('fleetGrid').innerHTML=query?'<div class="empty-fleet">No vehicles match your search.</div>':'<div class="empty-fleet"><strong>Your fleet will appear here</strong><p>Connect a vehicle API, then refresh to discover available vehicles.</p><button class="button ghost" type="button" data-open-connections>Add API connection</button></div>';return;}
  $('fleetGrid').innerHTML=rows.map(v=>`<div class="fleet-card ${v.internal_vehicle_id===selectedVehicleId?'active':''}"><div class="fleet-card-head"><div><strong>${esc(v.external_vehicle_id)}</strong><span>${esc(v.connection_name||'API')}</span></div><span class="status-online ${v.status==='online'?'':'stale'}">${esc(v.status||'known')}</span></div><div class="fleet-card-metrics"><span>${fmt(v.speed_kmh,1)} km/h</span><span>${fmt(v.lat,4)}, ${fmt(v.lon,4)}</span></div><button class="button ghost" data-monitor-vehicle="${esc(v.internal_vehicle_id)}">${v.internal_vehicle_id===selectedVehicleId?'Monitoring this vehicle':'Monitor vehicle'}</button></div>`).join('');
  $('fleetGrid').querySelectorAll('[data-monitor-vehicle]').forEach(b=>b.addEventListener('click',()=>{const v=state.fleet.find(x=>x.internal_vehicle_id===b.dataset.monitorVehicle);if(v){selectFleetVehicle(v);window.CALIBR8_UI?.setView('overview');}}));
}
function populateVehicleSelect(){const sel=$('fleetVehicleSelect'),rows=filteredFleet(),current=selectedVehicleId;sel.innerHTML=rows.length?rows.map(v=>`<option value="${esc(v.internal_vehicle_id)}">${esc(v.external_vehicle_id)} • ${esc(v.connection_name||'API')}</option>`).join(''):'<option value="">No vehicles found</option>';if(rows.some(v=>v.internal_vehicle_id===current))sel.value=current;else if(rows.length)sel.value=rows[0].internal_vehicle_id;}
function selectFleetVehicle(v){selectedConnectionId=v.connection_id;selectedExternalVehicleId=v.external_vehicle_id;selectedVehicleId=v.internal_vehicle_id;$('fleetConnectionSelect').value=v.connection_id;$('fleetVehicleSelect').value=v.internal_vehicle_id;attachLiveListeners();renderFleet();$('liveText').textContent='LIVE';if(sourceMode==='fleet_api'){isPlaying=true;restartTimer({immediate:true});}}

function isReplayMode(){return sourceMode==='replay'||sourceMode==='harsh_replay';}
function clearPlaybackTimer(){if(timer)clearTimeout(timer);timer=null;nextTickAt=null;}
function playbackDelayMs(out){if(sourceMode==='fleet_api'&&out?.fleet_api?.poll_interval_sec)return Math.max(1000,Number(out.fleet_api.poll_interval_sec)*1000);if(isReplayMode()&&out?.replay?.sourceDeltaSec!=null){let sourceMs=Math.max(1,Number(out.replay.sourceDeltaSec))*1000;if(compressGaps)sourceMs=Math.min(sourceMs,30000);return Math.max(150,sourceMs/Math.max(1,playbackSpeed));}return Math.max(750,CALIBR8_CONFIG.pollMs||1000);}
function updatePlaybackUI(delayMs=null){
  const replay=isReplayMode();$('replayControls').classList.toggle('hidden',!replay);
  $('startReplayBtn').disabled=!replay||isPlaying||tickInFlight;
  $('pauseReplayBtn').disabled=!replay||!isPlaying;
  $('restartReplayBtn').disabled=!replay||tickInFlight;
  $('injectHarshBtn').disabled=!replay||tickInFlight;
  $('playbackStatus').textContent=!replay?'Not a replay source':tickInFlight?'Loading sample…':isPlaying?'Playing':state.replay?'Paused':'Ready to start';
  if(!replay){$('nextTickText').textContent='Choose Sample API replay to run a recorded route.';return;}
  if(tickInFlight){$('nextTickText').textContent='Reading the sample and calculating braking results…';return;}
  if(!isPlaying){$('nextTickText').textContent=state.replay?`Paused at point ${state.replay.index+1}`:'Select a route, then press Start. No vehicle API is needed.';return;}
  const delay=delayMs??(nextTickAt?Math.max(0,nextTickAt-Date.now()):null);
  $('nextTickText').textContent=delay==null?'Next point: now':`Next point in ${(delay/1000).toFixed(delay<1000?2:1)} s · ${playbackSpeed}×`;
}
function showReplayError(message=''){
  $('replayError').textContent=message;$('replayError').classList.toggle('hidden',!message);
} 
function scheduleNext(delayMs){clearPlaybackTimer();if(!isPlaying||sourceMode==='push')return updatePlaybackUI();const delay=Math.max(0,Number(delayMs)||0);nextTickAt=Date.now()+delay;updatePlaybackUI(delay);timer=setTimeout(()=>sourceTick(),delay);}
async function sourceTick(forcePath=null){if(tickInFlight)return;if(sourceMode==='fleet_api'&&(!selectedConnectionId||!selectedExternalVehicleId)){$('liveText').textContent='SELECT VEHICLE';return;}tickInFlight=true;const generation=viewGeneration;if(isReplayMode())showReplayError();updatePlaybackUI();try{let out=null;const body={vehicle_id:selectedVehicleId,model:selectedModel,mode,scenario:selectedScenario};if(forcePath==='inject')out=await apiPost('/api/replay/inject',body);else if(sourceMode==='fleet_api')out=await apiPost('/api/monitor/tick',{connection_id:selectedConnectionId,external_vehicle_id:selectedExternalVehicleId,model:selectedModel,mode});else if(sourceMode==='replay')out=await apiPost('/api/replay/tick',body);else if(sourceMode==='harsh_replay')out=await apiPost('/api/replay/harsh/tick',body);else if(sourceMode==='demo')out=await apiPost('/api/demo/tick',body);else if(sourceMode==='external')out=await apiPost('/api/sync',body);if(generation!==viewGeneration||!user)return;applyDashboardPayload(out);if(out?.fleet_api){state.rawApi=out.raw_api_output||null;const st=out.fleet_api.status||{};setApiStatus('telemetry',out.fleet_api.connection_name||'Fleet API',`${st.latency_ms??'—'} ms`,!st.ok);setApiStatus('gps','Vehicle position received',out.fleet_api.stale?'same point':'new point');setApiStatus('context','Configured API context','ready');renderSourcePayload();}if(out?.replay){state.replay=out.replay;state.rawApi=out.raw_api_output||null;if(out.harsh_event)state.lastHarshReplay=out.harsh_event;renderSourcePayload();}$('liveText').textContent=isPlaying?'LIVE':'PAUSED';const delay=playbackDelayMs(out);if(isPlaying&&sourceMode!=='push')scheduleNext(delay);else updatePlaybackUI();return out;}catch(e){if(generation!==viewGeneration||!user)return;setApiStatus('inference',e.message,'error',true);if(isReplayMode()){isPlaying=false;clearPlaybackTimer();$('liveText').textContent='PAUSED';showReplayError(`Sample replay could not load: ${e.message}. Press Start to retry.`);}else{$('liveText').textContent='RECONNECTING';if(isPlaying&&sourceMode!=='push')scheduleNext(3000);}}finally{tickInFlight=false;updatePlaybackUI();if(user&&generation!==viewGeneration&&isPlaying&&sourceMode!=='push')scheduleNext(0);}}
function updateSourceUI(){const replay=isReplayMode(),customer=sourceMode==='fleet_api';$('scenarioControl').classList.toggle('hidden',!replay);$('fleetConnectionControl').classList.toggle('hidden',!customer);$('fleetVehicleControl').classList.toggle('hidden',!customer);$('fleetPanel').classList.toggle('hidden',!customer);$('replayControls').classList.toggle('hidden',!replay);document.querySelector('.replay-grid')?.classList.toggle('hidden',!(replay||customer));$('harshOutputCard').classList.toggle('hidden',!replay);if(sourceMode!=='harsh_replay')state.lastHarshReplay=null;renderSourcePayload();updatePlaybackUI();}
function restartTimer({immediate=true}={}){clearPlaybackTimer();updateSourceUI();if(sourceMode==='push'){$('liveText').textContent='LIVE';requestInferenceSoon();return;}if(sourceMode==='fleet_api'&&!selectedExternalVehicleId){$('liveText').textContent='SELECT VEHICLE';return;}if(!isPlaying){$('liveText').textContent='PAUSED';updatePlaybackUI();return;}if(immediate)sourceTick();else scheduleNext(sourceMode==='fleet_api'?3000:(CALIBR8_CONFIG.pollMs||1000));}
async function restartReplay(){if(!isReplayMode())return;clearPlaybackTimer();unsubscribeVehicle();resetVehicleView();try{await apiPost('/api/replay/reset',{vehicle_id:selectedVehicleId,scenario:selectedScenario});state.lastHarshReplay=null;state.replay=null;state.rawApi=null;labels.splice(0);speeds.splice(0);decels.splice(0);telemetryChart?.update();attachLiveListeners();renderSourcePayload();if(isPlaying)sourceTick();else updatePlaybackUI();}catch(e){console.error(e);}}
function switchToDemoVehicle(){selectedVehicleId=CALIBR8_CONFIG.vehicleId||'demo_vehicle';selectedConnectionId='';selectedExternalVehicleId='';attachLiveListeners();}

// Event handlers -----------------------------------------------------------------------
document.querySelectorAll('.seg').forEach(btn=>btn.addEventListener('click',async()=>{document.querySelectorAll('.seg').forEach(b=>b.classList.remove('active'));btn.classList.add('active');selectedModel=btn.dataset.model;updateWorkspaceSummary();$('modeSelect').disabled=selectedModel==='friend_gbm';$('modelNote').textContent=selectedModel==='friend_gbm'?'Original 4-class HistGradientBoosting model':`XGBoost + LightGBM ensemble • ${mode} threshold`;try{if(state.telemetry)applyDashboardPayload(await apiPost('/api/inference',{vehicle_id:selectedVehicleId,model:selectedModel,mode}));}catch(e){console.error(e);}}));
$('modeSelect').addEventListener('change',async e=>{mode=e.target.value;updateWorkspaceSummary();$('modelNote').textContent=`XGBoost + LightGBM ensemble • ${mode} threshold`;try{if(state.telemetry)applyDashboardPayload(await apiPost('/api/inference',{vehicle_id:selectedVehicleId,model:selectedModel,mode}));}catch(e){console.error(e);}});
async function setDataSource(next,{play=false}={}){
  if(!['fleet_api','replay','harsh_replay','demo','external','push'].includes(next))return;
  const revision=++sourceRevision;clearPlaybackTimer();sourceMode=next;$('sourceSelect').value=next;
  state.lastHarshReplay=null;showReplayError();isPlaying=isReplayMode()?play:sourceMode!=='push';
  // Update the visible controls immediately, before any fleet request completes.
  unsubscribeVehicle();resetVehicleView();updateSourceUI();
  if(sourceMode!=='fleet_api'){
    selectedVehicleId=CALIBR8_CONFIG.vehicleId||'demo_vehicle';selectedConnectionId='';selectedExternalVehicleId='';
    if(user)attachLiveListeners();restartTimer();return;
  }
  selectedConnectionId='';selectedExternalVehicleId='';$('liveText').textContent='SELECT VEHICLE';
  if(!user)return;
  await refreshFleet(true);
  if(revision!==sourceRevision||!user)return;
  const chosen=state.fleet.find(v=>v.internal_vehicle_id===selectedVehicleId)||state.fleet[0];
  if(chosen){if(selectedVehicleId!==chosen.internal_vehicle_id||!selectedExternalVehicleId)selectFleetVehicle(chosen);}
  else{$('liveText').textContent='NO VEHICLES';updateSourceUI();}
}
$('sourceSelect').value=sourceMode;
$('sourceSelect').addEventListener('change',event=>{setDataSource(event.target.value).catch(error=>window.CALIBR8_UI?.toast(error.message));});
$('runSampleBtn').addEventListener('click',()=>{window.CALIBR8_UI?.setView('overview');setDataSource('replay',{play:true}).catch(error=>showReplayError(error.message));});
$('showPayloadBtn').addEventListener('click',()=>{window.CALIBR8_UI?.setView('insights');const panel=document.querySelector('.source-details');panel.open=true;panel.scrollIntoView?.({behavior:'smooth',block:'start'});});
$('scenarioSelect').value=selectedScenario;$('scenarioSelect').addEventListener('change',async e=>{selectedScenario=e.target.value;unsubscribeVehicle();resetVehicleView();state.lastHarshReplay=null;state.replay=null;state.rawApi=null;try{await apiPost('/api/replay/reset',{vehicle_id:selectedVehicleId,scenario:selectedScenario});}catch(err){console.error(err);}attachLiveListeners();renderSourcePayload();if(isReplayMode())restartTimer();});
$('resetBtn').addEventListener('click',async()=>{try{if(isReplayMode()){await restartReplay();return;}await apiPost('/api/reset',{vehicle_id:selectedVehicleId});attachLiveListeners();state.lastHarshReplay=null;state.replay=null;state.rawApi=null;labels.splice(0);speeds.splice(0);decels.splice(0);telemetryChart?.update();renderSourcePayload();}catch(e){console.error(e);}});
$('playbackSpeed').value=String(playbackSpeed);$('playbackSpeed').addEventListener('change',e=>{playbackSpeed=Math.max(1,Number(e.target.value)||1);if(isPlaying&&isReplayMode())restartTimer({immediate:false});else updatePlaybackUI();});$('compressGaps').checked=compressGaps;$('compressGaps').addEventListener('change',e=>{compressGaps=Boolean(e.target.checked);if(isPlaying&&isReplayMode())restartTimer({immediate:false});else updatePlaybackUI();});$('startReplayBtn').addEventListener('click',()=>{if(!isReplayMode())return;isPlaying=true;$('liveText').textContent='LIVE';restartTimer({immediate:true});});$('pauseReplayBtn').addEventListener('click',()=>{if(!isReplayMode())return;isPlaying=false;clearPlaybackTimer();$('liveText').textContent='PAUSED';updatePlaybackUI();});$('restartReplayBtn').addEventListener('click',()=>restartReplay());$('injectHarshBtn').addEventListener('click',async()=>{if(!isReplayMode()||tickInFlight)return;clearPlaybackTimer();try{await sourceTick('inject');}finally{if(!isPlaying)updatePlaybackUI();}});
$('exportBtn').addEventListener('click',async()=>{if(!state.trip?.active_trip_id){window.CALIBR8_UI?.toast('Start monitoring a vehicle before exporting events.');return;}try{const tok=await token();const r=await fetch(`/api/export/events.csv?vehicle_id=${encodeURIComponent(selectedVehicleId)}&trip_id=${encodeURIComponent(state.trip.active_trip_id)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`HTTP ${r.status}`);const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`calibr8_${selectedVehicleId}_${state.trip.active_trip_id}_events.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){console.error(e);}});
$('fleetConnectionSelect').addEventListener('change',()=>{renderFleet();populateVehicleSelect();});$('fleetVehicleSelect').addEventListener('change',()=>{const v=state.fleet.find(x=>x.internal_vehicle_id===$('fleetVehicleSelect').value);if(v)selectFleetVehicle(v);});$('refreshFleetBtn').addEventListener('click',()=>refreshFleet(true));
$('manageApisBtn').addEventListener('click',()=>{window.CALIBR8_UI?.openConnections();loadConnections().catch(e=>window.CALIBR8_UI?.toast(e.message));});$('closeApiManagerBtn').addEventListener('click',()=>window.CALIBR8_UI?.closeConnections());$('clearConnectionFormBtn').addEventListener('click',clearConnectionForm);
$('connectionForm').addEventListener('submit',async e=>{e.preventDefault();const st=$('connectionFormStatus');st.className='form-status';st.textContent='Saving…';let headers=null;const rawHeaders=$('connectionHeaders').value.trim();if(rawHeaders){try{headers=JSON.parse(rawHeaders);}catch{st.className='form-status error';st.textContent='Headers must be valid JSON.';return;}}const payload={connection_id:$('connectionId').value||null,name:$('connectionName').value.trim(),url:$('connectionUrl').value.trim(),enabled:$('connectionEnabled').checked,root_path:$('rootPath').value.trim()||null,field_mapping:{device_id:$('mapDevice').value.trim(),timestamp:$('mapTimestamp').value.trim(),latitude:$('mapLat').value.trim(),longitude:$('mapLon').value.trim(),speed:$('mapSpeed').value.trim(),direction:$('mapDirection').value.trim()},timestamp_format:$('timestampFormat').value,speed_unit:$('speedUnit').value,poll_interval_sec:Number($('pollInterval').value),default_context:{vehicle_type:$('ctxVehicle').value,road_type:$('ctxRoad').value,traffic_density:$('ctxTraffic').value,weather:$('ctxWeather').value,road_surface:$('ctxSurface').value,road_grade_ratio:Number($('ctxGrade').value||0)/100}};if(rawHeaders)payload.headers=headers;try{const out=await apiPost('/api/connections',payload);clearConnectionForm();st.className='form-status success';st.textContent=`Saved ${out.connection.name}. Test it or refresh the fleet.`;await loadConnections();}catch(err){st.className='form-status error';st.textContent=err.message;}});

$('fleetSearch').addEventListener('input',renderFleet);
$('eventSearch').addEventListener('input',updateEvents);
$('enableFleetBtn').addEventListener('click',()=>{$('sourceSelect').value='fleet_api';$('sourceSelect').dispatchEvent(new Event('change'));});
$('centerMapBtn').addEventListener('click',()=>{if(map&&state.gps?.lat!=null&&state.gps?.lon!=null)map.setView([state.gps.lat,state.gps.lon],Math.max(15,map.getZoom()));else window.CALIBR8_UI?.toast('Waiting for a vehicle location.');});

// Authentication -----------------------------------------------------------------------
// The returned sign-in session and auth notifications both enter the same UI path.
// No database/API work runs while Supabase is dispatching an auth notification.
$('createAccountBtn').classList.toggle('hidden', CALIBR8_CONFIG.allowSelfSignup !== true);
$('anonymousBtn').classList.toggle('hidden', CALIBR8_CONFIG.allowAnonymousDemo !== true);

function setAuthBusy(busy){
  authBusy=busy;$('authForm').setAttribute('aria-busy',String(busy));
  const submit=$('authForm').querySelector('button[type="submit"]');if(submit)submit.disabled=busy;
}
function authProblem(error,fallback='Sign-in could not be completed. Please try again.'){
  $('authMessage').className='form-status error';$('authMessage').textContent=error?.message||fallback;
}
function acceptSession(nextSession){
  // Ignore any older initial-session read or queued notification.
  authSignal++;handleSession(nextSession);
}
async function finishSignIn(data){
  let next=data?.session;
  if(!next?.access_token){const restored=await supabase.auth.getSession();if(restored.error)throw restored.error;next=restored.data?.session;}
  if(!next?.access_token||!next.user?.id)throw new Error('Sign-in returned no usable session. Please try again.');
  acceptSession(next);$('authPassword').value='';$('authMessage').textContent='';
}
$('authForm').addEventListener('submit',async event=>{
  event.preventDefault();if(authBusy)return;setAuthBusy(true);
  $('authMessage').className='form-status';$('authMessage').textContent='Signing in…';
  try{
    const {data,error}=await supabase.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});
    if(error)throw error;
    // A successful HTTP response opens the workspace directly, even if SIGNED_IN
    // is delayed, missed, or was already delivered before this promise resolves.
    await finishSignIn(data);
  }catch(error){authProblem(error);}finally{setAuthBusy(false);}
});
$('createAccountBtn').addEventListener('click',async()=>{
  if(CALIBR8_CONFIG.allowSelfSignup!==true||authBusy)return;setAuthBusy(true);
  $('authMessage').className='form-status';$('authMessage').textContent='Creating account…';
  try{
    const {data,error}=await supabase.auth.signUp({email:$('authEmail').value.trim(),password:$('authPassword').value});
    if(error)throw error;
    if(data?.session)await finishSignIn(data);
    else{$('authMessage').className='form-status success';$('authMessage').textContent='Account created. Check your email if confirmation is required.';}
  }catch(error){authProblem(error);}finally{setAuthBusy(false);}
});
$('anonymousBtn').addEventListener('click',async()=>{
  if(CALIBR8_CONFIG.allowAnonymousDemo!==true||authBusy)return;setAuthBusy(true);
  try{const {data,error}=await supabase.auth.signInAnonymously();if(error)throw error;await finishSignIn(data);}
  catch(error){authProblem(error);}finally{setAuthBusy(false);}
});
$('signOutBtn').addEventListener('click',async()=>{
  $('signOutBtn').disabled=true;
  try{const result=await supabase.auth.signOut();if(result?.error)throw result.error;acceptSession(null);}
  catch(error){window.CALIBR8_UI?.toast(error.message||'Could not sign out. Please try again.');}
  finally{$('signOutBtn').disabled=false;}
});

function handleSession(nextSession){
  const next=nextSession?.access_token&&nextSession.user?.id?nextSession:null;
  session=next;user=next?.user||null;
  if(!user){
    authRevision++;initialized=false;workspaceOwnerId=null;workspaceLoad=null;
    clearTimeout(workspaceInitTimer);workspaceInitTimer=null;
    document.body.classList.remove('workspace-authenticated');$('authGate').classList.remove('hidden');
    $('authStatus').textContent='Signed out';$('signOutBtn').style.display='none';$('authPassword').value='';
    unsubscribeVehicle();clearPlaybackTimer();state.connections=[];state.fleet=[];
    selectedConnectionId='';selectedExternalVehicleId='';selectedVehicleId=CALIBR8_CONFIG.vehicleId||'demo_vehicle';
    window.CALIBR8_UI?.closeConnections();
    try{resetVehicleView();renderConnections();renderFleet();populateConnectionFilter();populateVehicleSelect();}catch(error){console.warn('Signed-out view cleanup:',error.message);}
    return;
  }
  // Synchronize the source controls before exposing the authenticated workspace.
  updateSourceUI();
  document.body.classList.add('workspace-authenticated');$('authGate').classList.add('hidden');
  $('authStatus').textContent=user.email||'Authenticated user';$('accountInitial').textContent=(user.email||'U').slice(0,1).toUpperCase();
  $('signOutBtn').style.display='inline-block';$('authMessage').textContent='';
  if(workspaceOwnerId===user.id&&(initialized||workspaceLoad||workspaceInitTimer))return;
  const ownerId=user.id,revision=++authRevision;
  const sourceAtAuth=sourceRevision;
  workspaceOwnerId=ownerId;initialized=false;$('firestoreStatus').textContent='Loading workspace';
  clearTimeout(workspaceInitTimer);
  workspaceInitTimer=setTimeout(()=>{
    workspaceInitTimer=null;
    if(!sessionIsCurrent(revision,ownerId))return;
    workspaceLoad=initializeWorkspace(revision,ownerId,sourceAtAuth).catch(error=>{
      if(sessionIsCurrent(revision,ownerId)){
        $('firestoreStatus').textContent='Workspace data unavailable';
        window.CALIBR8_UI?.toast('Signed in. Some workspace data could not load: '+error.message);
      }
    }).finally(()=>{if(sessionIsCurrent(revision,ownerId)){workspaceLoad=null;initialized=true;}});
  },0);
}
async function initializeWorkspace(revision,ownerId,sourceAtStart=sourceRevision){
  try{await loadConnections();}
  catch(error){if(sessionIsCurrent(revision,ownerId))window.CALIBR8_UI?.toast('Signed in. API connections could not load: '+error.message);}
  if(!sessionIsCurrent(revision,ownerId)||sourceAtStart!==sourceRevision)return;
  await refreshFleet(true);
  if(!sessionIsCurrent(revision,ownerId)||sourceAtStart!==sourceRevision)return;
  if(sourceMode==='fleet_api'){
    const vehicle=state.fleet.find(v=>v.internal_vehicle_id===selectedVehicleId)||state.fleet[0];
    if(vehicle)selectFleetVehicle(vehicle);
    else{$('liveText').textContent='ADD API';updateSourceUI();}
  }else{switchToDemoVehicle();restartTimer();}
  try{map?.invalidateSize();telemetryChart?.resize?.();}catch(error){console.warn('Widget resize:',error.message);}
}

// Register before initializing optional visual widgets or reading stored sessions.
supabase.auth.onAuthStateChange((_event,nextSession)=>{
  const signal=++authSignal;
  setTimeout(()=>{if(signal===authSignal)handleSession(nextSession);},0);
});
const restoreSignal=authSignal;
supabase.auth.getSession().then(({data,error})=>{
  if(restoreSignal!==authSignal)return;
  if(error)throw error;
  handleSession(data?.session||null);
}).catch(error=>{
  if(restoreSignal===authSignal){handleSession(null);authProblem(error,'Could not restore your session. Please sign in again.');}
});

// An unavailable map/chart must not interrupt authentication or screen changes.
try{initMap();}catch(error){map=routeLine=carMarker=null;$('map').textContent='Map could not load. GPS coordinates remain available.';console.warn('Map initialization:',error.message);}
try{initChart();}catch(error){telemetryChart=null;console.warn('Chart initialization:',error.message);}
try{resetVehicleView();updateSourceUI();}catch(error){console.warn('Dashboard initialization:',error.message);}
