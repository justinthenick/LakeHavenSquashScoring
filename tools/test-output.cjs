const fs=require('fs'),vm=require('vm'),assert=require('assert');let acorn;try{acorn=require('acorn');}catch(e){acorn=require('./package/dist/acorn.js');}
let count=0;function test(n,f){f();console.log('PASS '+n);count++;}
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('app-script/AdminApp.gs','utf8'),c);
const d={comp:'T',players:[{player_id:'a',name:'Same Name'},{player_id:'b',name:'Same Name'},{player_id:'c',name:'C'}],teams:[1,2,3].map(i=>({team_id:i,team_no:i,team_name:'Team '+i})),roster:[{player_id:'a',team_id:1,line:1},{player_id:'b',team_id:2,line:1},{player_id:'c',team_id:3,line:1}],fixtures:[{fixture_id:'f',round:1,line:1,team1_id:1,team2_id:2,player1_id:'a',player2_id:'b'},{fixture_id:'g',round:2,line:1,team1_id:2,team2_id:3,player1_id:'b',player2_id:'c'}],matches:[{fixture_id:'f',player1_id:'a',player2_id:'b',games_p1:3,games_p2:0,score_line:'3-0'},{fixture_id:'g',player1_id:'a',player2_id:'c',games_p1:3,games_p2:1,score_line:'3-1'}]};
let s=c.buildCompetitionStandings_(d,{}),r=c.reportFromStandings_(s);
test('same-name players are distinct by ID',()=>{assert.equal(s.individuals.find(x=>x.playerId==='a').points,6);assert.equal(s.individuals.find(x=>x.playerId==='b').points,1);});
test('missing substitute flag never grants extra individual points',()=>assert.equal(s.individuals.find(x=>x.playerId==='a').points,6));
test('substitute still contributes full team games and tie bonus',()=>assert.equal(s.teams.find(x=>x.teamNo===2).byRound[2],5));
test('scheduled absent player is AWAY and sub on bye retains BYE',()=>{assert.equal(r.lines[0].rows.find(x=>x.playerId==='a').byRound[1],'BYE');assert.equal(r.lines[0].rows.find(x=>x.playerId==='b').byRound[1],'AWAY');});
const duplicate=JSON.parse(JSON.stringify(d));duplicate.fixtures.push({...d.fixtures[0],fixture_id:'duplicate'});duplicate.matches.push({...d.matches[0],fixture_id:'duplicate'});
test('multiple scheduled appearances fail visibly instead of summing',()=>{const x=c.buildCompetitionStandings_(duplicate,{});assert.equal(c.reportFromStandings_(x).lines[0].rows[0].byRound[0],'CHECK');});
const partial=JSON.parse(JSON.stringify(d));partial.fixtures.push({...d.fixtures[0],fixture_id:'line2',line:2,player1_id:null,player2_id:null});
test('partial ties do not publish a premature team bonus',()=>assert.equal(c.buildCompetitionStandings_(partial,{}).teams.find(t=>t.teamNo===1).byRound[1],undefined));
const scratch=JSON.parse(JSON.stringify(d));Object.assign(scratch.matches[0],{games_p1:0,games_p2:0,score_line:'0-0 (scratched)'});
test('double scratch marks AWAY and awards team 1.5 each',()=>{const x=c.buildCompetitionStandings_(scratch,{});assert.equal(x.teams.find(t=>t.teamNo===1).byRound[1],1.5);assert.equal(c.reportFromStandings_(x).lines[0].rows[0].byRound[0],'AWAY');});
test('workbook URL parsing rejects arbitrary destinations',()=>{assert.equal(c.outputWorkbookId_('https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst/edit'),'abcdefghijklmnopqrst');assert.throws(()=>c.outputWorkbookId_('https://evil.example/id'));});
test('admin and scorer browser scripts parse',()=>{for(const f of ['app-script/Admin.html',fs.existsSync('site/index.html')?'site/index.html':'index.html']){const h=fs.readFileSync(f,'utf8');for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g))acorn.parse(m[1],{ecmaVersion:2022});}});
c.getOutputConfig_=()=>({workbookId:'test',url:'test'});c.validateOutputWorkbook_=()=>({});c.findSheet_=()=>({});c.loadCompetitionData_=()=>d;c.getRules_=()=>({});
test('round export blocks absent scan attachments',()=>assert.throws(()=>c.outputRoundPlan_('T',1),/Missing scanned sheets/));
test('round export blocks missing match results',()=>{const saved=d.matches;d.matches=[];assert.throws(()=>c.outputRoundPlan_('T',1),/Missing results/);d.matches=saved;});
test('blank output configuration blocks send with setup instructions',()=>{c.getOutputConfig_=()=>({workbookId:'',message:'Save workbook ID'});assert.throws(()=>c.outputRoundPlan_('T',1),/Save workbook ID/);});
let written;
c.SpreadsheetApp={flush(){}};
test('single native write preserves intervening formulas and verifies cells',()=>{
 const range={getValues:()=>written||[[1,10,2]],getFormulas:()=>[['','=SUM(A1,C1)','']],setValues:v=>{written=v;}};
 const sheet={getRange:()=>range};const req=(col,value)=>({updateCells:{range:{startRowIndex:0,startColumnIndex:col},rows:[{values:[{userEnteredValue:{numberValue:value}}]}]}});
 c.applyOutputCells_(sheet,[req(0,6),req(2,3)]);assert.equal(written[0][1],'=SUM(A1,C1)');assert.equal(written[0][0],6);assert.equal(written[0][2],3);
});
vm.runInContext(fs.readFileSync('app-script/Code.gs','utf8'),c);
c.sbGet_=()=>({ok:true,data:[{fixture_id:'played',games_p1:3,games_p2:1,score_line:'3-1'},{fixture_id:'scratch',games_p1:0,games_p2:0,score_line:'0-0 (scratched)'}]});c.requireSb_=r=>r;
c.CacheService={getScriptCache:()=>({getAll:()=>({'progress:live':JSON.stringify({games:[1,0],points:[7,4],players:['A','B']})})})};
test('fixture status distinguishes live, final, scratch, missing result and unplayed',()=>{const states=c.fixtureStatuses_(['played','scratch','live','missing','new'].map(id=>({fixture_id:id,played:id==='missing'})));assert.equal(states.played.status,'Played');assert.equal(states.scratch.status,'Scratched');assert.equal(states.live.status,'Underway');assert(states.live.result.includes('7–4'));assert.equal(states.missing.status,'Needs review');assert.equal(states.new.status,'Not yet played');});
test('retired scorer ID resolves to canonical identity',()=>{c.sbGet_=(t,q)=>t==='player_aliases'?{ok:true,data:[{player_id:'canonical'}]}:{ok:true,data:[{player_id:q.includes('canonical')?'canonical':'wrong'}]};assert.equal(c.resolveScorerIdentity_('retired','A'),'canonical');});
console.log(count+' output checks passed');
