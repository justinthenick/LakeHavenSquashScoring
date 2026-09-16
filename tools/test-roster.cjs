const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
let acorn;try{acorn=require('acorn');}catch(e){acorn=require('./package/dist/acorn.js');}
const base=path.resolve(__dirname,'..');let count=0;
function check(name,run){run();console.log('PASS '+name);count++;}
const server={Logger:{log(){}},console};vm.createContext(server);
vm.runInContext(fs.readFileSync(path.join(base,'app-script/AdminApp.gs'),'utf8'),server);
const players=[{player_id:'P-A',name:'Same Name'},{player_id:'P-B',name:'Same Name'},{player_id:'P-C',name:'Other Player'}];
let writes=[];
server.sbGet_=(table)=>({ok:true,data:table==='players'?players:[]});
server.sbUpdate_=(table,filter,patch)=>(writes.push({table,filter,patch}),{ok:true});
server.sbRpc_=()=>{throw Error('Existing contact must not resolve by name');};
check('existing same-name identities retain their IDs when moved',()=>{
 const rows=[{player:'Same Name',playerId:'P-A',teamNo:2,line:1,email:'first@example.test'},{player:'Same Name',playerId:'P-B',teamNo:1,line:1,email:'second@example.test'}];
 const r=server.syncContacts_(rows);assert(!r.error);assert.equal(writes[0].filter,'player_id=eq.P-A');assert.equal(writes[1].filter,'player_id=eq.P-B');assert.equal(rows[0].playerId,'P-A');assert.equal(rows[1].playerId,'P-B');
});
check('ambiguous names identify row, team, line and candidates before any write',()=>{
 writes=[];const r=server.syncContacts_([{player:'Other Player',teamNo:1,line:1,email:'new@example.test'},{player:'Same Name',teamNo:2,line:3}]);
 assert(r.error.includes('Same Name'));assert(r.error.includes('team 2, line 3'));assert(r.error.includes('P-A'));assert(r.error.includes('P-B'));assert.equal(writes.length,0);
});
check('stale player IDs cannot overwrite a different person',()=>{
 writes=[];const r=server.syncContacts_([{player:'Other Player',playerId:'P-A',teamNo:1,line:1}]);assert(r.error.includes('belongs to Same Name'));assert.equal(writes.length,0);
});
check('a single matching legacy name resolves to its existing ID',()=>{
 const row={player:'Other Player',teamNo:1,line:1};assert(!server.syncContacts_([row]).error);assert.equal(row.playerId,'P-C');
});
check('roster saves and fixture refresh receive distinct IDs, not a name map',()=>{
 const captured=[];server.sbGet_=(t)=>({ok:true,data:t==='players'?players:t==='teams'?[{team_id:11,team_no:1},{team_id:22,team_no:2}]:[]});
 server.sbDelete_=()=>({ok:true});server.sbUpsert_=(t,rows)=>(captured.push({t,rows}),{ok:true});
 const originalRefresh=server.applyRosterToFutureFixtures_;let refreshed;
 server.applyRosterToFutureFixtures_=(comp,rows)=>(refreshed=rows,{updated:1,frozen:1});
 const r=server.saveRoster_('COMP',[{player:'Same Name',playerId:'P-A',teamNo:2,teamName:'Two',line:1},{player:'Same Name',playerId:'P-B',teamNo:1,teamName:'One',line:1}]);
 assert(r.ok);assert.deepEqual(Array.from(captured.find(x=>x.t==='roster').rows,x=>x.player_id),['P-A','P-B']);assert.equal(refreshed[0].playerId,'P-A');server.applyRosterToFutureFixtures_=originalRefresh;
});
check('occupied team lines fail before deleting or changing contacts',()=>{
 server.sbGet_=()=>{throw Error('must validate slots first');};
 const r=server.saveRoster_('COMP',[{player:'Same Name',teamNo:1,line:1},{player:'Other Player',teamNo:1,line:1}]);assert(r.error.includes('two players'));
});
check('future fixture lookup preserves explicit same-name identities',()=>{
 let refreshed;
 server.sbGet_=(t,q)=>({ok:true,data:t==='players'?players:t==='teams'?[{team_id:11,team_no:1},{team_id:22,team_no:2}]:q.includes('played=eq.true')?[{fixture_id:'played'}]:[{fixture_id:'future',comp_ref:'COMP',round:2,line:1,scheduled:'2026-09-20',team1_id:11,team2_id:22,player1_id:'P-A',player2_id:'P-B',played:false}]});
 server.sbUpsert_=(t,rows)=>(refreshed=rows,{ok:true});
 const r=server.applyRosterToFutureFixtures_('COMP',[{player:'Same Name',playerId:'P-B',teamNo:1,line:1},{player:'Same Name',playerId:'P-A',teamNo:2,line:1}]);
 assert.equal(r.updated,1);assert.equal(r.frozen,1);assert.equal(refreshed[0].player1_id,'P-B');assert.equal(refreshed[0].player2_id,'P-A');
});
const html=fs.readFileSync(path.join(base,'app-script/Admin.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],ast=acorn.parse(script,{ecmaVersion:2022});
const client={};vm.createContext(client);vm.runInContext(ast.body.filter(n=>n.type==='FunctionDeclaration').map(n=>script.slice(n.start,n.end)).join('\n'),client);
check('contact selection retains ID and clears previous contact fields',()=>{
 const r={player:'Before',playerId:'old',email:'old@example.test',phone:'old',grade:'5'};client.selectRosterContact(r,{id:'P-B',name:'Same Name'});assert.equal(r.playerId,'P-B');assert.equal(r.email,'');assert.equal(r.phone,'');client.setRosterPlayerName(r,'Same Name');assert.equal(r.playerId,'P-B');client.setRosterPlayerName(r,'Different');assert.equal(r.playerId,'');
});
check('browser save payload includes player IDs',()=>{
 client.ROSTER=[{player:'Same Name',playerId:'P-B',teamNo:1,line:2}];client.ROSTERTEAMS=[{no:1,name:'One'}];client.collectRoster=()=>{};client.$=()=>({value:'COMP'});let payload;
 const runner={withSuccessHandler(){return this;},withFailureHandler(){return this;},saveRoster:(comp,json)=>payload=JSON.parse(json)};client.google={script:{run:runner}};client.saveRosterAction();assert.equal(payload[0].playerId,'P-B');
});
console.log(count+' roster checks passed');
