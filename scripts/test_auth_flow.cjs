/* Session/UI regression tests. No live Supabase account or credentials required.
 * Development dependencies: jsdom, @supabase/supabase-js (the last case uses the real SDK).
 * Run: node scripts/test_auth_flow.cjs
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(process.env.CALIBR8_AUTH_SOURCE||path.join(root,'public/app.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
const sessionFor=id=>({access_token:'local-test-access-token',user:{id,email:`${id}@example.com`}});
const pause=()=>new Promise(resolve=>setTimeout(resolve,4));
async function until(check,label){for(let i=0;i<125;i++){if(check())return;await pause();}assert.ok(check(),label);}
async function setup(options={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'public/index.html'),'utf8'),{url:'https://dashboard.test/',runScripts:'outside-only'});
 const w=dom.window,errors=[],warnings=[],callbacks=[],requests=[];
 w.console={log(){},warn(...args){warnings.push(args.map(String).join(' '));},error(...args){errors.push(args.map(String).join(' '));}};
 new vm.Script(fs.readFileSync(path.join(root,'public/ui.js'),'utf8')).runInContext(dom.getInternalVMContext());w.CALIBR8_UI.init();
 let current=options.initial||null;
 let pendingConnections=null;
 const fakeAuth={
  async getSession(){if(options.restoreGate)await options.restoreGate;return {data:{session:current},error:null};},
  onAuthStateChange(fn){callbacks.push(fn);return {data:{subscription:{unsubscribe(){}}}};},
  async signInWithPassword(){
   if(options.loginError)return {data:{session:null},error:{message:'Invalid login credentials'}};
   if(options.loginThrows)throw new Error('Authentication network unavailable');
   current=sessionFor('member');
   if(options.emitOnLogin)for(const fn of callbacks)fn('SIGNED_IN',current);
   return {data:{session:current,user:current.user},error:null};
  },
  async signOut(){current=null;if(options.emitOnLogout)for(const fn of callbacks)fn('SIGNED_OUT',null);return {error:null};}
 };
 let realClient=null;
 if(options.realSdk){
  const {createClient}=require('@supabase/supabase-js');
  const user={id:'00000000-0000-0000-0000-000000000001',email:'member@example.com',aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),app_metadata:{provider:'email'},user_metadata:{}};
  const exp=Math.floor(Date.now()/1000)+3600;
  const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt=enc({alg:'HS256',typ:'JWT'})+'.'+enc({sub:user.id,aud:'authenticated',role:'authenticated',email:user.email,iat:exp-3600,exp})+'.testsignature';
  w.createClient=(url,key,config)=>{
   realClient=createClient(url,key,{...config,auth:{...config.auth,storage:w.localStorage,storageKey:'calibr8-auth-test',autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,opts={})=>{
    const p=new URL(url);if(p.pathname.endsWith('/token'))return new Response(JSON.stringify({access_token:jwt,refresh_token:'local-test-refresh-token',token_type:'bearer',expires_in:3600,expires_at:exp,user}),{status:200,headers:{'Content-Type':'application/json'}});
    if(p.pathname.endsWith('/logout'))return new Response(null,{status:204});
    if(p.pathname.endsWith('/user'))return new Response(JSON.stringify(user),{status:200,headers:{'Content-Type':'application/json'}});
    throw new Error('Unexpected Auth request '+p.pathname);
   }}});
   return realClient;
  };
 }else w.createClient=()=>({auth:fakeAuth,removeChannel(){},channel(){return {on(){return this;},subscribe(){return this;}};}});
 w.CALIBR8_CONFIG={vehicleId:'demo_vehicle',defaultSource:'fleet_api',pollMs:60000};
 if(options.mapThrows)w.L={map(){throw new Error('Map initialization failed');}};
 w.fetch=async(url,opts={})=>{
  const pathname=new URL(url,w.location.href).pathname;requests.push({pathname,opts});
  if(options.api){const response=await options.api(pathname,opts);if(response!==undefined)return response;}
  if(pathname==='/api/client-config')return {ok:true,json:async()=>({supabase_url:'https://supabase.test',supabase_anon_key:'local-public-test-key'})};
  if(pathname==='/api/connections'&&options.connectionsGate){pendingConnections=options.connectionsGate;await pendingConnections;}
  if(pathname==='/api/connections'&&options.connectionsError)return {ok:false,status:503,json:async()=>({detail:'Data service unavailable'})};
  return {ok:true,status:200,json:async()=>pathname==='/api/connections'?{connections:[]}:pathname==='/api/state'?{vehicle_id:'demo_vehicle',live:{},route_points:[],events:[]}:{vehicles:[]}};
 };
 const program=`(async()=>{${source}\nwindow.__authTest={handleSession,token,sourceTick,stop(){unsubscribeVehicle();clearPlaybackTimer();},get initialized(){return initialized;}};})()`;
 let bootError=null;
 try{await new vm.Script(program,{filename:'app.js'}).runInContext(dom.getInternalVMContext());}catch(e){bootError=e;}
 const get=id=>w.document.getElementById(id);
 const loggedIn=()=>w.document.body.classList.contains('workspace-authenticated')&&get('authGate').classList.contains('hidden');
 const submit=()=>{get('authEmail').value='member@example.com';get('authPassword').value='local-test-password';get('authForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 const emit=(event,next)=>{current=next;for(const fn of callbacks){const result=fn(event,next);assert.equal(result,undefined,'Auth notification callback must remain synchronous');}};
 const close=async()=>{w.__authTest?.stop();if(realClient){await realClient.removeAllChannels();if(typeof realClient.auth.dispose==='function')await realClient.auth.dispose();else await realClient.auth.stopAutoRefresh();}dom.window.close();};
 return {w,get,errors,warnings,requests,callbacks,submit,emit,loggedIn,close,get bootError(){return bootError;}};
}
async function run(){
 let t=await setup();
 assert.ok(!t.loggedIn());t.submit();await until(t.loggedIn,'HTTP-success login must open the workspace without an auth notification');
 assert.equal(t.get('authPassword').value,'','Successful login clears the password field');
 t.get('signOutBtn').click();await until(()=>!t.loggedIn(),'Explicit sign-out must close the workspace without an auth notification');
 t.submit();await until(t.loggedIn,'Signing in again after sign-out must open the workspace');await t.close();
 console.log('PASS login response without auth events; explicit sign-out and sign-in again');

 t=await setup({initial:sessionFor('member')});await until(t.loggedIn,'Stored session must restore the workspace');
 await until(()=>t.w.__authTest.initialized,'Workspace initialization completes');
 const before=t.requests.filter(r=>r.pathname==='/api/fleet/discover').length;
 t.emit('TOKEN_REFRESHED',{...sessionFor('member'),access_token:'refreshed-test-token'});await pause();await pause();
 assert.ok(t.loggedIn());assert.equal(t.requests.filter(r=>r.pathname==='/api/fleet/discover').length,before,'Token refresh must preserve the workspace');
 t.emit('SIGNED_OUT',null);await until(()=>!t.loggedIn(),'Remote sign-out must close the workspace');
 t.emit('INITIAL_SESSION',null);await pause();assert.equal(t.errors.length,0,'Repeated null auth events must not throw');
 t.emit('SIGNED_IN',sessionFor('member'));await until(t.loggedIn,'Remote sign-in must open the workspace again');await t.close();
 console.log('PASS saved session, token refresh, remote sign-out/sign-in and repeated null sessions');

 for(const option of [{loginError:true},{loginThrows:true}]){
  t=await setup(option);t.submit();await until(()=>t.get('authMessage').classList.contains('error'),'Authentication errors must remain visible');
  assert.ok(!t.loggedIn());assert.equal(t.get('authForm').querySelector('button[type=submit]').disabled,false);await t.close();
 }
 console.log('PASS invalid credentials and network failures keep sign-in available');

 let release;const gate=new Promise(resolve=>release=resolve);
 t=await setup({connectionsGate:gate});t.submit();await until(t.loggedIn,'Slow fleet loading must not keep the login screen visible');
 t.get('signOutBtn').click();await until(()=>!t.loggedIn(),'Sign-out while loading must close the workspace');release();await pause();await pause();assert.ok(!t.loggedIn());await t.close();
 t=await setup({connectionsError:true});t.submit();await until(t.loggedIn,'Fleet API failure must not undo successful authentication');await t.close();
 console.log('PASS slow/failed fleet loads and sign-out during loading');

 t=await setup({mapThrows:true});assert.equal(t.bootError,null,'Map failure must not prevent auth setup');t.submit();await until(t.loggedIn,'Map failure must not block a successful sign-in');await t.close();
 console.log('PASS map/widget failures cannot block sign-in');

 t=await setup({realSdk:true});t.submit();await until(t.loggedIn,'Real Supabase SDK /token response must open the workspace');
 t.get('signOutBtn').click();await until(()=>!t.loggedIn(),'Real Supabase SDK sign-out must close the workspace');await t.close();
 console.log('PASS actual Supabase SDK with mocked Auth HTTP transport');
}
module.exports={setup,until,sessionFor};
if(require.main===module)run().catch(e=>{console.error(e);process.exit(1);});
