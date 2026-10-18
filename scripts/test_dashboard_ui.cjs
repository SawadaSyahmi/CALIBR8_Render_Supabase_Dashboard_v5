/* UI regression test with the actual page/app, HTTP fixtures and no Realtime delivery.
 * First generate fixtures with backend/test_dashboard_state.py (CALIBR8_TEST_FIXTURES).
 * Development dependency: jsdom. Run: node scripts/test_dashboard_ui.cjs FIXTURES.json
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');

const root = path.resolve(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sourcePath = process.env.CALIBR8_UI_SOURCE || path.join(root, 'public/app.js');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function eventually(check, label) {
  for (let i = 0; i < 150; i++) { if (check()) return; await tick(); }
  assert.ok(check(), label);
}

async function run() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), {
    url: 'https://calibr8.test/', runScripts: 'outside-only'
  });
  const w = dom.window, errors = [], authCallbacks = [];
  const styles=w.document.createElement('style');styles.textContent=fs.readFileSync(path.join(root,'public/style.css'),'utf8');w.document.head.append(styles);
  new vm.Script(fs.readFileSync(path.join(root,'public/ui.js'),'utf8')).runInContext(dom.getInternalVMContext());
  w.CALIBR8_UI.init();
  w.console = {log() {}, warn() {}, error(...e) { errors.push(e.map(String).join(' ')); }};
  let activeSession = {access_token: 'test-session-token', user: {id: 'test-user', email: 'test@example.com'}};
  const channels = [];
  w.createClient = () => ({
    auth: {
      async getSession() { return {data: {session: activeSession}}; },
      onAuthStateChange(callback) { authCallbacks.push(callback); },
      async signOut() { activeSession = null; for (const fn of authCallbacks) fn('SIGNED_OUT', null); }
    },
    channel(name) {
      const channel = {
        name, handlers: [],
        on(_kind, filter, callback) { this.handlers.push({filter, callback}); return this; },
        subscribe(callback) { callback?.('CHANNEL_ERROR'); return this; }
      };
      channels.push(channel);return channel;
    },
    removeChannel() {},
    from() { throw new Error('Direct Supabase data reads are unavailable in this test'); }
  });
  w.CALIBR8_CONFIG = {vehicleId: 'demo_vehicle', defaultSource: 'fleet_api', pollMs: 60000};
  w.Chart = class Chart {
    static defaults = {};
    constructor(_canvas, config) { this.data = config.data;this.options=config.options; }
    resize() {}
    update() {}
  };
  let clock = Date.now() + 1000;
  let stored = {vehicle_id: 'demo_vehicle', live: {}, route_points: [], events: []};
  let nextTickGate = null;
  const requests = [];
  function stamp(value) {
    const out = copy(value), iso = new Date(clock += 10).toISOString();
    function walk(v) { if (v && typeof v === 'object') for (const key of Object.keys(v)) {
      if (['server_time', 'server_updated_at', 'updated_at'].includes(key)) v[key] = iso;
      else walk(v[key]);
    }}
    walk(out);return out;
  }
  function inferenceReply(template, body) {
    const out = stamp(template);
    out.vehicle_id = body.vehicle_id || 'demo_vehicle';
    out.selected_model = body.model || 'new_ai';out.selected_mode = body.mode || 'balanced';
    if (stored.live.trip) {
      out.trip.active_trip_id = stored.live.trip.active_trip_id;
      out.trip.distance_km = Math.max(out.trip.distance_km, stored.live.trip.distance_km);
    }
    if (out.route_point) out.route_point.trip_id = out.trip.active_trip_id;
    if (out.trip.last_route_point) out.trip.last_route_point.trip_id = out.trip.active_trip_id;
    if (out.event) out.event.trip_id = out.trip.active_trip_id;
    stored = {
      vehicle_id: out.vehicle_id,
      live: {telemetry: out.telemetry, gps: out.gps, context: out.context, trip: out.trip, inference: out, raw_api: out.raw_api_output || {}},
      route_points: out.route_point ? [out.route_point] : [], events: out.event ? [out.event] : []
    };
    return out;
  }
  w.fetch = async (url, options = {}) => {
    const parsed = new URL(url, w.location.href), pathname = parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({pathname, body});
    let data;
    if (pathname === '/api/client-config') data = {supabase_url: 'https://supabase.test', supabase_anon_key: 'public-test-key'};
    else if (pathname === '/api/connections') data = options.method==='POST'?{ok:true,connection:{...body,connection_id:'saved-connection'}}:{connections: []};
    else if (pathname === '/api/fleet' || pathname === '/api/fleet/discover') data = {vehicles: []};
    else if (pathname === '/api/state') data = parsed.searchParams.get('vehicle_id') === stored.vehicle_id ? copy(stored) : {vehicle_id: parsed.searchParams.get('vehicle_id'), live: {}, route_points: [], events: []};
    else if (pathname === '/api/replay/tick' || pathname === '/api/replay/harsh/tick') {
      if (nextTickGate) { const gate = nextTickGate;nextTickGate = null;await gate; }
      data = inferenceReply(fixtures.normal, body);
    } else if (pathname === '/api/replay/inject') data = inferenceReply(fixtures.harsh, body);
    else if (pathname === '/api/inference') data = inferenceReply(body.model === 'friend_gbm' ? fixtures.friend : fixtures.harsh, body);
    else if (pathname === '/api/monitor/tick') data = inferenceReply(fixtures.fleet, {...body, vehicle_id: fixtures.fleet.vehicle_id});
    else if (pathname === '/api/replay/reset' || pathname === '/api/reset') {
      stored = copy(fixtures.reset_snapshot);data = {ok: true, trip: stored.live.trip};
    } else throw new Error(`Unexpected request: ${pathname}`);
    return {ok: true, status: 200, async json() { return data; }};
  };
  let source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*;\r?\n/gm, '');
  source += '\nwindow.__dashboardTest = {state, sourceTick, refreshDashboardSnapshot, applyLiveRow, applyDashboardPayload, selectFleetVehicle, stop(){unsubscribeVehicle();clearPlaybackTimer();}, get labels(){return labels;}, get chart(){return telemetryChart;}};';
  await new vm.Script(`(async()=>{${source}\n})()`, {filename: sourcePath}).runInContext(dom.getInternalVMContext());
  const ui = w.__dashboardTest, get = id => w.document.getElementById(id);
  function sourceChange(value) { get('sourceSelect').value = value;get('sourceSelect').dispatchEvent(new w.Event('change')); }
  assert.equal(get('speed').textContent, '—', 'Missing readings must have a waiting indicator');
  sourceChange('replay');
  assert.equal(get('startReplayBtn').disabled,false);get('startReplayBtn').click();
  await eventually(() => get('speed').textContent === fixtures.normal.gps.speed_kmh.toFixed(1), 'Replay must update Speed from HTTP without Realtime');
  get('pauseReplayBtn').click();
  assert.notEqual(get('peak').textContent, '—');
  assert.ok(Number.parseFloat(get('available').textContent) > 0);
  assert.ok(Number.parseFloat(get('distance').textContent) > 0);
  assert.notEqual(get('newAiMini').textContent, '—');
  assert.notEqual(get('friendMini').textContent, '—');
  assert.equal(ui.chart.data.datasets[0].data.at(-1), fixtures.normal.gps.speed_kmh);
  assert.ok(ui.state.route.length > 0);
  console.log('PASS replay: speed, braking, physics, both AI scores, distance, route and chart from HTTP');

  get('injectHarshBtn').click();
  await eventually(() => get('decisionBadge').textContent === 'HARSH / SEVERE', 'Injected braking must update the decision card');
  assert.equal(get('peak').textContent, '-6.50');
  assert.equal(get('jerk').textContent, '-13.00');
  assert.ok(Number(get('util').textContent) > 60);
  assert.ok(Number.parseFloat(get('riskPct').textContent) > 90);
  assert.equal(get('harshCount').textContent, '1');
  assert.ok(ui.state.events.length > 0);
  assert.ok(get('eventRows').textContent.includes('CALIBR8-AI'));
  console.log('PASS harsh injection: decision, peak, jerk, utilisation and event history');

  const routeCount = ui.state.route.length, eventCount = ui.state.events.length, chartCount = ui.labels.length;
  ui.applyDashboardPayload(stored.live.inference);
  ui.applyLiveRow({vehicle_id: 'demo_vehicle', kind: 'inference', data: stored.live.inference});
  assert.equal(ui.state.route.length, routeCount);
  assert.equal(ui.state.events.length, eventCount);
  assert.equal(ui.labels.length, chartCount);
  console.log('PASS HTTP + Realtime duplicate deliveries do not duplicate routes, events or chart samples');

  get('modelSettingsToggle').click();assert.equal(get('modelSettingsToggle').getAttribute('aria-expanded'),'true');
  w.document.querySelector('[data-model="friend_gbm"]').click();
  await eventually(() => get('modelName').textContent.includes('Friend GBM'), 'Model switch must consume its HTTP result');
  assert.ok(Number.parseFloat(get('riskPct').textContent) > 90);
  console.log('PASS model switch while paused updates directly');

  const beforeRefresh = get('speed').textContent;
  for (const callback of authCallbacks) callback('TOKEN_REFRESHED', activeSession);
  await tick();assert.equal(get('speed').textContent, beforeRefresh);
  console.log('PASS token refresh keeps current measurements and playback state');

  sourceChange('push');await tick();await ui.refreshDashboardSnapshot();
  await eventually(() => get('peak').textContent === '-6.50', 'Push source restores readings through HTTP state fallback');
  assert.ok(requests.some(r => r.pathname === '/api/state'));
  console.log('PASS push/state fallback with Realtime unavailable');

  // A response for a previously selected vehicle must never enter the new view.
  ui.selectFleetVehicle({internal_vehicle_id: 'different-car', connection_id: 'conn', external_vehicle_id: 'CAR-2'});
  await tick();ui.applyDashboardPayload(stored.live.inference);
  assert.equal(get('speed').textContent, '—');
  assert.equal(ui.state.route.length, 0);
  console.log('PASS vehicle selection ignores responses for another vehicle');

  // Exercise fleet sourceTick itself with the saved live-API contract.
  sourceChange('fleet_api');
  ui.selectFleetVehicle({internal_vehicle_id: fixtures.fleet.vehicle_id, connection_id: 'test-conn', external_vehicle_id: 'CAR-1'});
  await eventually(() => get('speed').textContent === '32.0', 'Fleet measurements must update from the live API response');
  assert.equal(get('peak').textContent, '-2.88');
  console.log('PASS fleet monitoring: current speed 32 km/h and GPS-derived braking');

  // Verify appearance controls update every component and persist the preference.
  w.document.querySelector('[data-theme-choice="light"]').click();
  assert.equal(w.document.documentElement.dataset.theme,'light');
  assert.equal(w.localStorage.getItem('calibr8-theme'),'light');
  assert.equal(w.document.querySelectorAll('[data-theme-choice="light"][aria-pressed="true"]').length,2);
  assert.equal(ui.chart.data.datasets[0].borderColor,'#07836f');
  w.document.querySelector('[data-theme-choice="dark"]').click();
  assert.equal(w.document.documentElement.dataset.theme,'dark');
  assert.equal(ui.chart.data.datasets[0].borderColor,'#52d8bd');
  w.document.querySelector('[data-theme-choice="system"]').click();
  assert.equal(w.localStorage.getItem('calibr8-theme'),'system');
  console.log('PASS light/dark/system themes, synchronized controls, persistent choice and chart colours');

  for(const view of ['fleet','events','insights','overview']){
    w.document.querySelector(`.nav-item[data-view="${view}"]`).click();
    assert.equal(w.CALIBR8_UI.view,view);
    assert.equal(w.document.querySelectorAll('[data-panel]:not(.hidden)').length,1);
    assert.equal(w.document.querySelector('[data-panel]:not(.hidden)').dataset.panel,view);
  }
  get('menuToggle').click();assert.equal(get('menuToggle').getAttribute('aria-expanded'),'true');
  get('sidebarScrim').click();assert.equal(get('menuToggle').getAttribute('aria-expanded'),'false');
  console.log('PASS workspace navigation and mobile menu');

  get('manageApisBtn').focus();get('manageApisBtn').click();
  assert.ok(!get('apiManager').classList.contains('hidden'));
  assert.equal(w.document.activeElement.id,'closeApiManagerBtn');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
  assert.ok(get('apiManager').classList.contains('hidden'));
  assert.equal(w.document.activeElement.id,'manageApisBtn');
  get('passwordToggle').click();assert.equal(get('authPassword').type,'text');
  get('passwordToggle').click();assert.equal(get('authPassword').type,'password');
  console.log('PASS dialog keyboard dismissal, focus restoration and password visibility');

  get('eventSearch').value='no matching event';get('eventSearch').dispatchEvent(new w.Event('input'));
  assert.ok(get('eventRows').textContent.includes('No events match'));
  get('eventSearch').value='';get('eventSearch').dispatchEvent(new w.Event('input'));
  ui.state.fleet=[{internal_vehicle_id:'car-1',external_vehicle_id:'CAR-1',connection_id:'test-conn',connection_name:'Test fleet',speed_kmh:32,lat:3,lon:101,status:'online'}];
  get('fleetSearch').value='car-1';get('fleetSearch').dispatchEvent(new w.Event('input'));
  assert.equal(get('fleetGrid').querySelectorAll('.fleet-card').length,1);
  get('fleetSearch').value='absent';get('fleetSearch').dispatchEvent(new w.Event('input'));
  assert.ok(get('fleetGrid').textContent.includes('No vehicles match'));
  console.log('PASS fleet and event search');
  get('connectionName').value='North fleet';get('connectionUrl').value='https://example.com/vehicles';
  get('connectionForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await eventually(()=>get('connectionFormStatus').textContent.includes('Saved North fleet'),'Connection save feedback must remain visible');
  const savedRequest=requests.find(r=>r.pathname==='/api/connections'&&r.body.name==='North fleet');
  assert.equal(savedRequest.body.field_mapping.device_id,'deviceId');
  assert.equal(savedRequest.body.default_context.vehicle_type,'passenger_car');
  assert.equal(savedRequest.body.poll_interval_sec,5);
  console.log('PASS connection form keeps field mapping/context and visible save confirmation');

  await tick();ui.stop();dom.window.close();
  assert.deepEqual(errors, [], 'No UI runtime errors');
  console.log(`PASS all UI regression checks (${requests.length} HTTP requests; zero Realtime data messages)`);
}
run().catch(error => {console.error(error);process.exit(1);});
