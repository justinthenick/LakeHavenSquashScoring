const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
let acorn;try{acorn=require('acorn');}catch(e){acorn=require('./package/dist/acorn.js');}
const base=path.resolve(__dirname,'..');let count=0;
function check(name,run){run();console.log('PASS '+name);count++;}
const site=fs.existsSync(path.join(base,'site/index.html'))?path.join(base,'site'):base;
const frontend=fs.readFileSync(path.join(site,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const ast=acorn.parse(frontend,{ecmaVersion:2022});
let memory={};const elements=new Proxy({}, {get:(o,k)=>o[k]||(o[k]={textContent:'',disabled:false,value:'',classList:{add(){},remove(){},contains(){return false;}}})});
const ctx={navigator:{},store:{get:k=>memory[k],set:(k,v)=>memory[k]=v,del:k=>delete memory[k],keys:()=>Object.keys(memory)},QKEY:'cc_queue',flushInFlight:null,document:{getElementById:id=>elements[id]},Date,JSON,Promise,setTimeout,clearTimeout};
vm.createContext(ctx);vm.runInContext(ast.body.filter(n=>n.type==='FunctionDeclaration').map(n=>frontend.slice(n.start,n.end)).join('\n'),ctx);
const cfg={players:[{name:'A'},{name:'B'}],pointsToWin:15,winByTwo:false,bestOf:5,firstServer:0};
check('frontend and service worker parse',()=>new vm.Script(fs.readFileSync(path.join(site,'sw.js'),'utf8')));
check('normal match and match-point undo',()=>{const m=ctx.createMatch(cfg);for(let i=0;i<45;i++)ctx.wonRally(m,0);assert(m.over);assert.equal(m.games.length,3);ctx.undo(m);assert(!m.over);assert.equal(m.points[0],14);});
check('undo restores break timing and abandonment',()=>{const m=ctx.createMatch(cfg);m.timing={gameSec:24,breakActive:false};for(let i=0;i<15;i++)ctx.wonRally(m,0);m.timing.breakActive=true;ctx.undo(m);assert.equal(m.timing.breakActive,false);assert.equal(m.timing.gameSec,24);ctx.abandonMatch(m,0);ctx.undo(m);assert.equal(m.abandoned,false);});
check('locked result cannot be undone',()=>{const m=ctx.createMatch(cfg);ctx.wonRally(m,0);m.locked=true;ctx.undo(m);assert.equal(m.points[0],1);});
check('abandonment respects deuce target',()=>{const m=ctx.createMatch({...cfg,winByTwo:true});m.points=[15,16];ctx.abandonMatch(m,0);assert.equal(m.games[0].points[0],18);});
let email='',props={CLUB_ACCESS_CODE:'0a2B'},rpcCalls=[];
const crypto=require('crypto');let lockHeld=false;
const backend={Session:{getActiveUser:()=>({getEmail:()=>email})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||'',setProperty:(k,v)=>props[k]=v})},LockService:{getScriptLock:()=>({tryLock:()=>{if(lockHeld)return false;lockHeld=true;return true;},releaseLock:()=>lockHeld=false})},Utilities:{getUuid:()=>crypto.randomUUID(),computeHmacSha256Signature:(s,k)=>crypto.createHmac('sha256',k).update(s).digest(),base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url')},Logger:{log(){}},console,Date,JSON};vm.createContext(backend);
for(const f of fs.readdirSync(path.join(base,'app-script')).filter(f=>f.endsWith('.gs'))){const s=fs.readFileSync(path.join(base,'app-script',f),'utf8');acorn.parse(s,{ecmaVersion:2022});vm.runInContext(s,backend);}
check('anonymous admin calls fail closed',()=>{assert.throws(()=>backend.getContacts(),/sign-in required/);assert.throws(()=>backend.deleteRubbers('[]'),/sign-in required/);});
check('authorized project editor accepted',()=>{email='justin@masteryournetwork.com.au';assert.equal(backend.assertAdmin_(),email);});
check('public credential and database helper names absent',()=>{for(const n of ['prop','propOpt','sbGet','sbUpsert','sbDelete','sbUpdate','writeResult','syncContacts'])assert.equal(backend[n],undefined,n);});
let deviceToken;
check('four-character code enrolls device, not direct API access',()=>{assert.throws(()=>backend.authorizeDevice_('wrong'));deviceToken=backend.authorizeDevice_('0a2B').token;backend.requireClubCode_(deviceToken);assert.throws(()=>backend.requireClubCode_('0a2B'));assert.throws(()=>backend.requireClubCode_(deviceToken+'x'));assert(!lockHeld);});
check('failed enrollment throttles new devices without blocking existing ones',()=>{for(let i=0;i<4;i++)assert.throws(()=>backend.authorizeDevice_('wrong'));assert.throws(()=>backend.authorizeDevice_('0a2B'),/paused/);backend.requireClubCode_(deviceToken);assert(!lockHeld);});
check('code rotation revokes existing devices',()=>{props.CLUB_ACCESS_CODE='9z8X';assert.throws(()=>backend.requireClubCode_(deviceToken));props.CLUB_ACCESS_CODE='0a2B';});
check('enrollment resumes after cooldown and expired tokens fail',()=>{props.CLUB_LOGIN_ATTEMPTS=JSON.stringify({until:Date.now()-1,failures:5});backend.requireClubCode_(backend.authorizeDevice_('0a2B').token);const data='cc1.'+(Date.now()-1)+'.test';assert.throws(()=>backend.requireClubCode_(data+'.'+backend.deviceSignature_(data,props.CLUB_DEVICE_SIGNING_KEY,props.CLUB_ACCESS_CODE)));});
check('every exported admin function remains guarded',()=>{for(const file of fs.readdirSync(path.join(base,'app-script')).filter(f=>f.endsWith('.gs'))){const source=fs.readFileSync(path.join(base,'app-script',file),'utf8');for(const n of acorn.parse(source,{ecmaVersion:2022}).body.filter(n=>n.type==='FunctionDeclaration')){const name=n.id.name;if(!name.endsWith('_')&&!['doGet','doPost'].includes(name))assert(String(backend[name]).includes('assertAdmin_'),name);}}});
check('rallies preserve manual service-box changes',()=>{const r=backend.writeRallyLog_('x',{history:'12',serviceHistory:'BD'},'p1','p2');assert.equal(r[0].box,'L');assert.equal(r[1].server_player_id,'p2');assert.equal(r[1].box,'L');});
check('scorer saves through a single RPC only',()=>{backend.fixtureInfo_=()=>({compRef:'C',scheduled:'2026-09-01T14:00:00Z'});backend.normDate_=()=> '2026-09-02';backend.resolveScorerIdentity_=id=>id;backend.combineDateTime_=()=>null;backend.sbRpc_=(name,args)=>{rpcCalls.push({name,args});return {ok:true};};const res=backend.writeResult_({matchId:'m',fixtureId:'f',player1Id:'p1',player2Id:'p2',winnerIndex:1,gamesP1:3,gamesP2:0,games:[{p1:15,p2:0,winner:1}],history:''});assert(res.ok);assert.equal(rpcCalls.length,1);assert.equal(rpcCalls[0].name,'cc_submit_queued_result');assert.equal(rpcCalls[0].args.p_match.match_date,'2026-09-01T14:00:00Z');});
(async()=>{
 ctx.enqueue({matchId:'old'});let release;ctx.postResult=()=>new Promise(r=>release=r);const flushing=ctx.flushQueue();await Promise.resolve();ctx.enqueue({matchId:'new'});release({ok:true});await flushing;
 check('concurrent enqueue survives queue flush',()=>assert.deepEqual(ctx.loadQueue().map(p=>p.matchId),['new']));
 memory={cc_queue:JSON.stringify([{matchId:'legacy'}])};check('legacy queue migration retains payload',()=>assert.equal(ctx.loadQueue()[0].matchId,'legacy'));
 ctx.enqueue({matchId:'good'});const sent=[];ctx.postResult=p=>p.matchId==='legacy'?Promise.reject({reason:'server',msg:'Needs review'}):(sent.push(p.matchId),Promise.resolve({ok:true}));await ctx.flushQueue();
 check('one rejected result does not block later results',()=>{assert.deepEqual(sent,['good']);assert.equal(ctx.loadQueue()[0].queueError,'Needs review');});
 console.log(count+' checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
