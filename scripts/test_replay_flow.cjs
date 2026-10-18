/* Empty-fleet startup, source switching and replay request recovery.
 * Generate fixtures as documented in MEASUREMENTS_FIX.md, then run:
 * node scripts/test_replay_flow.cjs FIXTURES.json
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const {setup,until,sessionFor}=require('./test_auth_flow.cjs');
const fixtures=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const pause=()=>new Promise(resolve=>setTimeout(resolve,4));
const template=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const raw=new JSDOM(template);assert.ok(raw.window.document.getElementById('replayControls').classList.contains('hidden'));assert.ok(raw.window.document.getElementById('scenarioControl').classList.contains('hidden'));raw.window.close();
console.log('PASS initial HTML does not flash replay controls in live mode');
async function run(){
 let release;const gate=new Promise(resolve=>release=resolve);let failNext=false,sequence=0;
 const t=await setup({initial:sessionFor('member'),connectionsGate:gate,api:async(p,opts)=>{
  if(!['/api/replay/tick','/api/replay/inject'].includes(p))return;
  if(failNext){failNext=false;return {ok:false,status:502,json:async()=>({detail:'Replay storage temporarily unavailable'})};}
  const data=JSON.parse(JSON.stringify(p.endsWith('/inject')?fixtures.harsh:fixtures.normal));
  const body=JSON.parse(opts.body||'{}');data.vehicle_id=body.vehicle_id||'demo_vehicle';data.selected_model=body.model||'new_ai';data.selected_mode=body.mode||'balanced';
  const stamp=new Date(Date.now()+(++sequence)*100).toISOString();
  function walk(v){if(v&&typeof v==='object')for(const key of Object.keys(v)){if(['server_time','server_updated_at','updated_at'].includes(key))v[key]=stamp;else walk(v[key]);}}
  walk(data);data.replay.index=10+sequence;data.route_point.id='sample-'+sequence;data.trip.last_route_point.id=data.route_point.id;
  return {ok:true,status:200,json:async()=>data};
 }});
 const get=t.get;
 try{
  await until(t.loggedIn,'Saved session opens the workspace');
  assert.equal(get('sourceSelect').value,'fleet_api');assert.ok(get('replayControls').classList.contains('hidden'));assert.ok(!get('runSampleBtn').classList.contains('hidden'));
  get('runSampleBtn').click();
  await until(()=>get('speed').textContent==='36.5'&&get('playbackStatus').textContent==='Playing','One-click replay starts while live-fleet initialization is pending');
  assert.equal(get('sourceSelect').value,'replay');assert.ok(!get('replayControls').classList.contains('hidden'));assert.ok(!get('scenarioControl').classList.contains('hidden'));
  assert.ok(get('apiOutput').textContent.includes('deviceId'));assert.ok(!t.requests.some(r=>r.pathname==='/api/monitor/tick'));
  get('pauseReplayBtn').click();release();
  await until(()=>t.w.__authTest.initialized,'Original workspace initialization finishes');
  assert.equal(get('sourceSelect').value,'replay');assert.ok(!get('replayControls').classList.contains('hidden'));assert.equal(get('speed').textContent,'36.5');
  console.log('PASS sample replay starts without live vehicles and survives delayed workspace loading');

  get('showPayloadBtn').click();assert.equal(t.w.CALIBR8_UI.view,'insights');assert.equal(t.w.document.querySelector('.source-details').open,true);assert.ok(get('apiOutput').textContent.includes('deviceId'));
  console.log('PASS View API output opens the current sample payload');

  failNext=true;await t.w.__authTest.sourceTick();
  assert.ok(!get('replayError').classList.contains('hidden'));assert.ok(get('replayError').textContent.includes('Replay storage temporarily unavailable'));assert.equal(get('startReplayBtn').disabled,false);assert.equal(get('playbackStatus').textContent,'Paused');
  get('startReplayBtn').click();await until(()=>get('playbackStatus').textContent==='Playing'&&get('replayError').classList.contains('hidden'),'Start retries after a failed sample request');get('pauseReplayBtn').click();
  console.log('PASS replay failures stay visible and Start successfully retries');

  get('sourceSelect').value='fleet_api';get('sourceSelect').dispatchEvent(new t.w.Event('change'));
  await until(()=>get('liveText').textContent==='NO VEHICLES','Empty live fleet has a clear status');assert.ok(get('replayControls').classList.contains('hidden'));
  const before=t.requests.filter(r=>r.pathname==='/api/replay/tick').length;
  get('sourceSelect').value='replay';get('sourceSelect').dispatchEvent(new t.w.Event('change'));await pause();
  assert.equal(t.requests.filter(r=>r.pathname==='/api/replay/tick').length,before,'Selecting a replay route waits for explicit Start');assert.equal(get('startReplayBtn').disabled,false);
  get('startReplayBtn').click();await until(()=>t.requests.filter(r=>r.pathname==='/api/replay/tick').length>before&&get('playbackStatus').textContent==='Playing','Dropdown sample mode runs after Start');
  console.log('PASS dropdown source changes, manual Start and empty-fleet sample entry');
  assert.deepEqual(t.errors,[]);
 }catch(error){console.error({source:get('sourceSelect').value,status:get('playbackStatus').textContent,speed:get('speed').textContent,replayError:get('replayError').textContent,live:get('liveText').textContent,requests:t.requests.map(r=>r.pathname),errors:t.errors,warnings:t.warnings});throw error;}finally{release();await t.close();}
}
run().catch(error=>{console.error(error);process.exit(1);});
