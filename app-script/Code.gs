/**************************************************************************
 * Court Card — Google Apps Script backend
 *
 * Paste into the target Sheet (Extensions ▸ Apps Script). In Project
 * Settings ▸ Script Properties add SECRET (and DRAW_ID for DrawImport),
 * then Deploy ▸ New deployment ▸ Web app:
 *      Execute as:      Me
 *      Who has access:  Anyone
 * Copy the /exec URL into CONFIG.APPS_SCRIPT_URL in index.html
 * and use the same SECRET value in CONFIG.SHARED_SECRET.
 *
 * The app is the ONLY writer, and only to two raw append-only tabs:
 *   MatchLog  — one row per match
 *   GameLog   — one row per game  (authoritative for points)
 * Build ladders / progress as separate QUERY tabs that READ these.
 * Never point the app at a formula-driven tab.
 **************************************************************************/

var FIXTURES_TAB = 'Fixtures';
var MATCHLOG_TAB = 'MatchLog';
var GAMELOG_TAB  = 'GameLog';

// Config from Script Properties (Project Settings > Script Properties).
// This helper is shared across this project's files (Code.gs + DrawImport.gs).
//   SECRET   = shared secret; must equal CONFIG.SHARED_SECRET in the scorer app
//   DRAW_ID  = the "Teams and Draw" workbook file id (used by DrawImport.gs)
function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Script Property "' + name + '" is not set');
  return v;
}

// Case-insensitive sheet lookup so 'fixtures' / 'Fixtures' / 'GameLog' etc all resolve.
function findSheet_(ss, name) {
  var t = String(name).toLowerCase();
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (all[i].getName().toLowerCase() === t) return all[i];
  return null;
}

/* Fixtures headers (row 1, matched by name, any subset / order):
 *   Id | Player1 | Player2 | Color1 | Color2 | PointsToWin | BestOf | Event | Venue | Played
 * MatchLog / GameLog are created automatically with headers on first save. */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    requireClubCode_(body.secret);
    if (body.action === 'result') return json_(writeResult_(body));
    return json_({ ok:false, error:'unknown action' });
  } catch (err) { return json_({ ok:false, error:String(err) }); }
}

/* ---------- read fixtures ---------- */
// LIVE CUTOVER: reads from Supabase instead of MASTER's Fixtures tab.
// Output contract is UNCHANGED from the Sheets version - same keys, same
// filtering (unplayed + player1 assigned), across every comp at once (no
// comp filter here - matches the original, which read the whole tab).
//
// Real difference from the Sheets version: fixtures.player1_id/team1_id
// etc. are foreign keys, not denormalized name text - Sheets stored the
// actual name string directly. The PWA's picker UI needs readable names,
// so this does the join itself (players/teams lookup by id) rather than
// gambling on PostgREST's FK-embedding query syntax without being able to
// test it against the real schema first.
//
// 'played' is now a real boolean (played=eq.false) instead of "does this
// cell have a date value in it" - a genuine simplification the relational
// schema buys for free, not just a straight port.
function readFixtures_() {
  var res = sbGet_('fixtures', 'select=fixture_id,round,line,scheduled,comp_ref,team1_id,team2_id,player1_id,player2_id&played=eq.false&player1_id=not.is.null');
  if (!res.ok) throw new Error('readFixtures: ' + res.error);
  var fixtures = res.data;
  if (!fixtures.length) return [];

  var playerIds = {}, teamIds = {};
  fixtures.forEach(function(f){
    if (f.player1_id) playerIds[f.player1_id] = true;
    if (f.player2_id) playerIds[f.player2_id] = true;
    if (f.team1_id) teamIds[f.team1_id] = true;
    if (f.team2_id) teamIds[f.team2_id] = true;
  });
  // Realistic scale here is the live remaining-season fixture set (dozens,
  // not thousands) - a single IN(...) query is fine, no batching needed.
  var playerNames = {}, teamNames = {};
  var pids = Object.keys(playerIds);
  if (pids.length) {
    var pr = sbGet_('players', 'select=player_id,name&player_id=in.(' + pids.join(',') + ')');
    if (!pr.ok) throw new Error('readFixtures (players lookup): ' + pr.error);
    pr.data.forEach(function(p){ playerNames[p.player_id] = p.name; });
  }
  var tids = Object.keys(teamIds);
  if (tids.length) {
    var tr = sbGet_('teams', 'select=team_id,team_name&team_id=in.(' + tids.join(',') + ')');
    if (!tr.ok) throw new Error('readFixtures (teams lookup): ' + tr.error);
    tr.data.forEach(function(t){ teamNames[t.team_id] = t.team_name; });
  }

  var rules={};requireSb_(sbGet_('comps','select=comp_ref,points_per_game,win_by_two,best_of')).data.forEach(function(c){rules[c.comp_ref]=c;});
  var tz = 'Australia/Sydney';
  return fixtures.map(function(f){
    var sched = '';
    if (f.scheduled) {
      try { sched = Utilities.formatDate(new Date(f.scheduled), tz, 'yyyy-MM-dd'); }
      catch (e) { sched = String(f.scheduled).slice(0, 10); }
    }
    return {
      id: f.fixture_id, player1Id:f.player1_id, player2Id:f.player2_id,
      pointsToWin:(rules[f.comp_ref]||{}).points_per_game||15,winByTwo:!!(rules[f.comp_ref]||{}).win_by_two,bestOf:(rules[f.comp_ref]||{}).best_of||5,
      player1: playerNames[f.player1_id] || '', player2: playerNames[f.player2_id] || '',
      scheduled: sched,
      comp: f.comp_ref, round: f.round, line: f.line,
      team1: teamNames[f.team1_id] || '', team2: teamNames[f.team2_id] || '',
      event: f.comp_ref
    };
  });
}
function g_(row, i) { return i > -1 ? row[i] : ''; }
function num_(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }

// Sheets serial (days since 1899-12-30) -> 'yyyy-MM-dd'. 25569 = serial of 1970-01-01.
// Formatted in UTC because the serial encodes a calendar date with no timezone.
function serialToYMD_(serial) {
  var ms = Math.round((serial - 25569) * 86400000);
  return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy-MM-dd');
}

/* ---------- canonical schema + alias-tolerant header-aware writes ---------- */
var MATCHLOG_HEAD = ['MatchId','Timestamp','Date','Comp','FixtureId','Player1','Player2','GamesP1','GamesP2','Winner','ScoreLine','DurationSec','ScanLink','RallyWinners','Source','PlayerID1','PlayerID2','Sub1','Sub2'];
var GAMELOG_HEAD  = ['MatchId','GameNo','Date','Comp','Player1','Player2','PointsP1','PointsP2','GameWinner','TimeStart','TimeEnd','Duration','BreakTime','Scorer','Ref','FixtureId','CommittedDatetime','ScanLink','PlayerID1','PlayerID2'];
var RALLYLOG_HEAD = ['MatchId','Date','FixtureId','Game','Rally','Server','Box','P1Score','P2Score','RallyWinner'];
// aliases only where a rename/misspelling exists (spaces & case handled by normH_)
var COLALIAS = { comp:['comp','event'], committeddatetime:['committeddatetime','commiteddatetime'] };
function normH_(s){ return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
function findCol_(header, canon){ var cn=normH_(canon), al=COLALIAS[cn]||[cn];
  for(var i=0;i<header.length;i++){ var hn=normH_(header[i]); if(hn===cn||al.indexOf(hn)>=0) return i; } return -1; }
// build a row matching the sheet's actual header from an object keyed by normalized canonical names
function rowForHeader_(header, obj){
  return header.map(function(h){ var hn=normH_(h);
    if(obj.hasOwnProperty(hn)) return obj[hn];
    for(var k in obj){ var al=COLALIAS[k]; if(al && al.indexOf(hn)>=0) return obj[k]; }
    return '';
  });
}

/* ---------- write result (MatchLog + GameLog, one atomic call) ---------- */
function writeResult_(b){
 if(!b||!b.matchId||!b.fixtureId)return {ok:false,error:'Select a fixture before saving.',retryable:false};
 var fx=fixtureInfo_(b.fixtureId);if(!fx)return {ok:false,error:'Fixture could not be loaded. Retry after refreshing fixtures.',retryable:true};
 b.date=fx.scheduled?normDate_(fx.scheduled,'Australia/Sydney'):b.date;
 var pid1=resolveScorerIdentity_(b.player1Id,b.player1),pid2=resolveScorerIdentity_(b.player2Id,b.player2);
 if(!pid1||!pid2||pid1===pid2)return {ok:false,error:'Select two different registered players.',retryable:false};
 var win=Number(b.winnerIndex)||((b.winner===b.player1)?1:((b.winner===b.player2)?2:0));
 var match={match_id:String(b.matchId),fixture_id:String(b.fixtureId),comp_ref:fx.compRef,match_date:fx.scheduled||toDate_(b.date),player1_id:pid1,player2_id:pid2,sub1:!!b.sub1,sub2:!!b.sub2,games_p1:b.gamesP1,games_p2:b.gamesP2,winner_id:win===1?pid1:(win===2?pid2:null),score_line:b.scoreLine||'',duration_sec:b.durationSec||0,scan_link:'',source:'app',raw_rally_history:b.history||''};
 var games=(b.games||[]).map(function(g,i){return {game_no:i+1,points_p1:g.p1,points_p2:g.p2,game_winner_id:g.winner===1?pid1:(g.winner===2?pid2:null),time_start:combineDateTime_(b.date,g.timeStart),time_end:combineDateTime_(b.date,g.timeEnd),duration:g.duration||0,break_time:g.breakTime||0,scorer:b.scorer||'',ref:b.ref||''};});
 return sbRpc_('cc_save_result',{p_match:match,p_games:games,p_rallies:writeRallyLog_(b.matchId,b,pid1,pid2),p_replace:false});
}
function resolveScorerIdentity_(id,name){
 if(id){var r=sbGet_('players','select=player_id&player_id=eq.'+encodeURIComponent(id));requireSb_(r);return r.data.length?r.data[0].player_id:'';}
 return contactId_(name);
}

/* ---------- RallyLog: reconstruct point-by-point from the compact history ----------
   b.history = "121|22..." (rally winners 1/2 per game, games split by "|")
   b.firstServer = 1 or 2 (who served first in game 1). PAR rules: server keeps serve and
   swaps box on winning; on losing, the receiver becomes server starting in the R box.
   Server of game N (N>1) = winner of game N-1 (the last rally of that game).
   pid1/pid2 passed in from writeResult() - avoids a second Contacts lookup,
   and lets server/winner resolve by position rather than name text. */
function writeRallyLog_(matchId, b, pid1, pid2) {
  var hist = String(b.history || '');
  if (!hist) return [];
  if(!/^[12]+(?:\|[12]+)*$/.test(hist))throw new Error('Invalid rally history');
  var firstServer = (parseInt(b.firstServer, 10) === 2) ? 1 : 0;  // 0-based
  var out_ = [], games = hist.split('|'), services=String(b.serviceHistory||'').split('|');
  var startServer = firstServer;
  for (var gi = 0; gi < games.length; gi++) {
    var seq = games[gi], score = [0, 0], server = startServer, side = 'R', lastWinner = startServer;
    for (var r = 0; r < seq.length; r++) {
      var w = (seq.charAt(r) === '2') ? 1 : 0;
      var recorded=(services[gi]||'').charAt(r);
      if(recorded){if(!/^[ABCD]$/.test(recorded))throw new Error('Invalid service history');server=recorded<'C'?0:1;side=(recorded==='A'||recorded==='C')?'R':'L';}
      var srvId = server === 0 ? pid1 : pid2, srvBox = side;
      score[w]++;
      out_.push({ match_id: matchId, fixture_id: b.fixtureId||'', rally_date: toDate_(b.date),
        game_no: gi+1, rally_no: r+1, server_player_id: srvId||null, box: srvBox,
        p1_score: score[0], p2_score: score[1], rally_winner_id: (w===0?pid1:pid2)||null });
      if (w === server) { side = (side === 'R') ? 'L' : 'R'; }
      else { server = w; side = 'R'; }
      lastWinner = w;
    }
    startServer = lastWinner;
  }
  return out_;
}

/* ---------- other lines in the same team-vs-team tie (for the scorer's break screen) ----------
   Given the current rubber's fixtureId (COMP-R#-L#-M#), find its sibling lines (same COMP/round/M),
   join to MatchLog for played results, and tally rubbers won by each team. */
function tieResults_(fixtureId) {
  var mm = String(fixtureId || '').match(/^(.*)-R(\d+)-L(\d+)-M(\d+)$/);
  if (!mm) return { ok:false, error:'bad fixtureId' };
  var comp = mm[1], round = mm[2], tie = mm[4];

  // Sibling fixtures (the other lines in this same tie) - from Supabase,
  // not the Sheets Fixtures tab, which is no longer written to.
  var fxRes = sbGet_('fixtures', 'select=fixture_id,round,line,comp_ref,team1_id,team2_id,player1_id,player2_id&comp_ref=eq.'+encodeURIComponent(comp)+'&round=eq.'+encodeURIComponent(round));
  if (!fxRes.ok) return { ok:false, error:'fixtures lookup failed: '+fxRes.error };
  var sibRows = fxRes.data.filter(function(f){
    var m2 = String(f.fixture_id||'').match(/^(.*)-R(\d+)-L(\d+)-M(\d+)$/);
    return m2 && m2[4] === tie;
  });
  if (!sibRows.length) return { ok:false, error:'no sibling fixtures' };

  var playerIds = {}, teamIds = {};
  sibRows.forEach(function(f){
    if (f.player1_id) playerIds[f.player1_id] = true;
    if (f.player2_id) playerIds[f.player2_id] = true;
    if (f.team1_id) teamIds[f.team1_id] = true;
    if (f.team2_id) teamIds[f.team2_id] = true;
  });
  var playerNames = {}, teamNames = {};
  var pids = Object.keys(playerIds);
  if (pids.length) {
    var pr = sbGet_('players', 'select=player_id,name&player_id=in.(' + pids.join(',') + ')');
    if (!pr.ok) return { ok:false, error:'players lookup failed: '+pr.error };
    pr.data.forEach(function(p){ playerNames[p.player_id] = p.name; });
  }
  var tids = Object.keys(teamIds);
  if (tids.length) {
    var tr = sbGet_('teams', 'select=team_id,team_name&team_id=in.(' + tids.join(',') + ')');
    if (!tr.ok) return { ok:false, error:'teams lookup failed: '+tr.error };
    tr.data.forEach(function(t){ teamNames[t.team_id] = t.team_name; });
  }

  var sibs = sibRows.map(function(f){
    var m2 = String(f.fixture_id).match(/^(.*)-R(\d+)-L(\d+)-M(\d+)$/);
    return { line: parseInt(m2[3], 10), id: f.fixture_id,
      t1: teamNames[f.team1_id] || '', t2: teamNames[f.team2_id] || '',
      p1: playerNames[f.player1_id] || '', p2: playerNames[f.player2_id] || '' };
  });
  sibs.sort(function (a, b) { return a.line - b.line; });
  var teamA = sibs[0].t1, teamB = sibs[0].t2;

  // Results - from Supabase match_log, not the Sheets MatchLog tab.
  var res = {};
  var mlRes = sbGet_('match_log', 'select=fixture_id,winner_id,games_p1,games_p2&comp_ref=eq.'+encodeURIComponent(comp));
  if (!mlRes.ok) return { ok:false, error:'match_log lookup failed: '+mlRes.error };
  var winnerIds = {};
  mlRes.data.forEach(function(m){ if (m.winner_id) winnerIds[m.winner_id] = true; });
  var winnerNames = {};
  var wids = Object.keys(winnerIds);
  if (wids.length) {
    var wr = sbGet_('players', 'select=player_id,name&player_id=in.(' + wids.join(',') + ')');
    if (wr.ok) wr.data.forEach(function(p){ winnerNames[p.player_id] = p.name; });
  }
  mlRes.data.forEach(function(m){
    res[m.fixture_id] = { winner: winnerNames[m.winner_id] || '',
      gp1: Number(m.games_p1) || 0, gp2: Number(m.games_p2) || 0 };
  });

  var wonA = 0, wonB = 0, lines = [];
  sibs.forEach(function (s) {
    var r = res[s.id];
    if (r) {
      var teamAWon = r.gp1 > r.gp2;                 // Player1 slot = Team1/A (scorer keeps fixture order)
      if (teamAWon) wonA++; else wonB++;
      lines.push({ line: s.line, fixtureId: s.id, p1: s.p1, p2: s.p2, played: true,
        winnerName: r.winner, winnerTeam: teamAWon ? 'A' : 'B',
        games: Math.max(r.gp1, r.gp2) + '-' + Math.min(r.gp1, r.gp2) });
    } else {
      lines.push({ line: s.line, fixtureId: s.id, p1: s.p1, p2: s.p2, played: false,
        winnerName: '', winnerTeam: '', games: '' });
    }
  });
  return { ok:true, teamA: teamA, teamB: teamB, wonA: wonA, wonB: wonB, lines: lines };
}

// LIVE CUTOVER: same idempotency check, now against Supabase.
function matchExists_(matchId) {
  var res = sbGet_('match_log', 'select=match_id&match_id=eq.'+encodeURIComponent(matchId));
  if(!res.ok){ Logger.log('matchExists: '+res.error); return false; }  // fail open - same risk profile as a Sheets read error before
  return res.data.length > 0;
}
function fixtureHasResult_(fixtureId) {
  if(!fixtureId) return false;
  var res = sbGet_('match_log', 'select=match_id&fixture_id=eq.'+encodeURIComponent(fixtureId));
  if(!res.ok){ Logger.log('fixtureHasResult: '+res.error); return false; }
  return res.data.length > 0;
}

function fixtureInfo_(fixtureId){
  if(!fixtureId) return null;
  var res = sbGet_('fixtures', 'select=scheduled,comp_ref&fixture_id=eq.'+encodeURIComponent(fixtureId));
  if(!res.ok || !res.data.length) return null;
  return { scheduled: res.data[0].scheduled, compRef: res.data[0].comp_ref };
}
function markPlayed_(fixtureId) {
  if (!fixtureId) return;
  var res = sbUpdate_('fixtures', 'fixture_id=eq.'+encodeURIComponent(fixtureId), {played:true});
  if(!res.ok) Logger.log('markPlayed('+fixtureId+') failed: '+res.error);
}

// LIVE CUTOVER: resolves a player name to their PlayerID via Supabase,
// cached once per execution (same pattern as the original Sheets version -
// one full players fetch, not one query per lookup).
function contactId_(name){
 var n=String(name||'').trim();if(!n)return '';
 var r=requireSb_(sbGet_('players','select=player_id,name'));
 var hits=r.data.filter(function(p){return _normName_(p.name)===_normName_(n);});
 if(hits.length>1)throw new Error('Ambiguous player name. Select a player ID.');
 return hits.length?hits[0].player_id:'';
}

// Full roster of player names, for the PWA's sub-entry autocomplete. Plain
// name strings (not ids) - the client only ever resolves by name, same as
// contactId_ does server-side at write time.
function listPlayerNames_(){
  var res = sbGet_('players', 'select=player_id,name');
  if(!res.ok){ Logger.log('listPlayerNames: '+res.error); return []; }
  return res.data.map(function(p){ return {id:p.player_id,name:String(p.name||'').trim()}; }).filter(function(p){return p.name;}).sort(function(a,b){return a.name.localeCompare(b.name);});
}

// Dedupe-by-normalized-name against players, same numbering convention as
// AdminApp.gs's syncContacts (PXXXX, next free number). Returns the
// canonical stored name (existing or newly minted) so the client can set
// the field to exactly what's now in Supabase.
function resolveOrAddPlayer_(name){return sbRpc_('cc_resolve_player',{p_name:String(name||'').trim()});}
function toDate_(val){
 if(val instanceof Date)return val;
 var s=String(val||'').trim();if(!s)return null;
 if(/^\d{4}-\d{2}-\d{2}T/.test(s)){var instant=new Date(s);if(isNaN(instant.getTime()))throw new Error('Invalid timestamp');return instant;}
 var day=normDate_(s,'Australia/Sydney');if(!day)throw new Error('Invalid calendar date');
 return Utilities.parseDate(day,'Australia/Sydney','yyyy-MM-dd');
}

// The PWA's clockNow() (index.html) deliberately returns a bare "HH:MM:SS"
// string - a lightweight in-match display value, never a full date. Sheets
// tolerated that as untyped text; game_log.time_start/time_end are real
// TIMESTAMPTZ columns and correctly reject it (Postgres error 22007).
// This combines that bare time with the match's actual calendar date
// (already resolved via fixtureInfo_ above) into a genuinely valid
// timestamp, rather than changing what the PWA sends.
function combineDateTime_(dateVal,timeStr){
 if(!timeStr)return null;
 if(/^\d{4}-\d{2}-\d{2}T/.test(String(timeStr)))return new Date(timeStr);
 if(!/^\d{2}:\d{2}:\d{2}$/.test(String(timeStr)))throw new Error('Invalid game time');
 return Utilities.parseDate(normDate_(dateVal,'Australia/Sydney')+' '+timeStr,'Australia/Sydney','yyyy-MM-dd HH:mm:ss');
}

function out_(obj, e) {
  var body = JSON.stringify(obj);
  if (e && e.parameter && e.parameter.callback) {
    if(!/^__cc_[0-9]+$/.test(e.parameter.callback))return ContentService.createTextOutput('{"ok":false,"error":"Invalid callback"}').setMimeType(ContentService.MimeType.JSON);
    return ContentService.createTextOutput(e.parameter.callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
