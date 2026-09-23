/**************************************************************************
 * Court Card — Comp Admin (standalone Apps Script web app)
 *
 * Create a NEW Apps Script project (script.google.com > New project),
 * add this file + Admin.html, then:
 *   1. Project Settings > Script Properties, add:
 *        MASTER_ID  = the master workbook file id
 *        GEMINI_KEY = your free Google AI Studio key
 *   2. Keep the scorer deployment running as the owner. For additional
 *      admins, create a separate deployment executing as the accessing user.
 *      See SETUP.md for the Google identity and workbook access requirements.
 * Same-origin with the backend (google.script.run), so no CORS anywhere.
 **************************************************************************/

// Model comes from Script Property GEMINI_MODEL (swap without redeploying);
// default is a current model confirmed available to new projects.
function geminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-3.5-flash';
}

// Config lives in Script Properties (Project Settings > Script Properties):
//   MASTER_ID  = master workbook file id (Comps / Fixtures / GameLog)
//   GEMINI_KEY = Google AI Studio key
function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Script Property "' + name + '" is not set');
  return v;
}
function propOpt_(name) { return PropertiesService.getScriptProperties().getProperty(name) || ''; }
function findSheet_(ss, name) {
  var t = String(name).toLowerCase();
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (all[i].getName().toLowerCase() === t) return all[i];
  return null;
}

function doGet(e) {
  // PWA/API requests carry an 'action' param; a plain browser hit (opening
  // the /exec URL directly, no params) is what renders the Admin page.
  if (e && e.parameter && e.parameter.action) {
    try {
      if(e.parameter.action==='authorizeDevice')return out_(authorizeDevice_(e.parameter.code),e);
      requireClubCode_(e.parameter.secret);
      var action = e.parameter.action;
      if (action === 'fixtures') return out_({ ok:true, fixtures: readFixtures_() }, e);
      if (action === 'result')   return out_(writeResult_(JSON.parse(e.parameter.data || '{}')), e);
      if (action === 'progress') return out_(fixtureProgress_(JSON.parse(e.parameter.data||'{}')),e);
      if (action === 'tie')      return out_(tieResults_(e.parameter.fixtureId || ''), e);
      if (action === 'players')  return out_({ ok:true, players: listPlayerNames_().map(function(p){return p.name;}), playerRecords:listPlayerNames_() }, e);
      if (action === 'addPlayer') return out_(resolveOrAddPlayer_(e.parameter.name || ''), e);
      return out_({ ok:true, msg:'Court Card backend live' }, e);
    } catch (err) { return out_({ ok:false, error:String(err) }, e); }
  }
  try { assertAdmin_(); } catch(err) { return HtmlService.createHtmlOutput('<h1>Administrator sign-in required</h1><p>'+String(err.message||err).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];})+'</p><p>The club scorer code does not grant administrator access.</p>'); }
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('Comp Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- comps ---------- */
function getActiveComps_() {
  var res = sbGet_('comps', 'select=comp_ref,comp_name,points_per_game,win_by_two,best_of&active=eq.true');
  if (!res.ok) { Logger.log('getActiveComps: '+res.error); return []; }
  return res.data.map(function(c){
    return {
      code: c.comp_ref, name: c.comp_name || c.comp_ref,
      pointsToWin: c.points_per_game || 15,
      winByTwo: !!c.win_by_two,
      bestOf: c.best_of || 5
    };
  });
}
// Round-by-round schedule for the Draw tab: every fixture for the comp,
// grouped by round then by tie (the M# suffix), each with its 5 lines
// (player names + played status). Read-only view - no roster/result
// changes happen here.
function getDrawCalendar_(comp){
  var fxRes = sbGet_('fixtures', 'select=fixture_id,round,line,scheduled,team1_id,team2_id,player1_id,player2_id,played&comp_ref=eq.'+encodeURIComponent(comp));
  if(!fxRes.ok) return {ok:false, error:fxRes.error};
  if(!fxRes.data.length) return {ok:false, error:'no fixtures for '+comp};

  var teamIds={}, playerIds={};
  fxRes.data.forEach(function(f){ if(f.team1_id)teamIds[f.team1_id]=1; if(f.team2_id)teamIds[f.team2_id]=1;
    if(f.player1_id)playerIds[f.player1_id]=1; if(f.player2_id)playerIds[f.player2_id]=1; });
  var teamInfo={}, playerNames={};
  var tids=Object.keys(teamIds);
  if(tids.length){ var tr=sbGet_('teams','select=team_id,team_no,team_name&team_id=in.('+tids.join(',')+')');
    if(tr.ok) tr.data.forEach(function(t){teamInfo[t.team_id]={no:t.team_no,name:t.team_name};}); }
  var pids=Object.keys(playerIds);
  if(pids.length){ var pr=sbGet_('players','select=player_id,name&player_id=in.('+pids.join(',')+')');
    if(pr.ok) pr.data.forEach(function(p){playerNames[p.player_id]=p.name;}); }
  function tno(id){ return id&&teamInfo[id]?teamInfo[id].no:null; }
  function tname(id){ return id&&teamInfo[id]?teamInfo[id].name:''; }
  function pname(id){ return id&&playerNames[id]?playerNames[id]:''; }

  var byRound={};
  fxRes.data.forEach(function(f){
    var r=parseInt(f.round,10); if(!r) return;
    var m=String(f.fixture_id).match(/-M(\d+)$/); var tie=m?m[1]:'1';
    byRound[r]=byRound[r]||{};
    if(!byRound[r][tie]) byRound[r][tie]={ tie:tie, team1:tname(f.team1_id), team1No:tno(f.team1_id),
      team2:tname(f.team2_id), team2No:tno(f.team2_id), scheduled:f.scheduled, lines:[] };
    byRound[r][tie].lines.push({ line:parseInt(f.line,10)||0, fixtureId:f.fixture_id,
      player1:pname(f.player1_id), player2:pname(f.player2_id), played:!!f.played });
  });
  var rounds = Object.keys(byRound).map(Number).sort(function(a,b){return a-b;}).map(function(r){
    var ties = Object.keys(byRound[r]).map(function(k){ var t=byRound[r][k]; t.lines.sort(function(a,b){return a.line-b.line;}); return t; });
    ties.sort(function(a,b){ return (a.team1No||0)-(b.team1No||0); });
    return { round:r, scheduled: ties.length?ties[0].scheduled:null, ties:ties };
  });
  return { ok:true, comp:comp, rounds:rounds };
}

function getRules_(code) {
  var cs = getActiveComps_();
  for (var i = 0; i < cs.length; i++) if (cs[i].code === code) return cs[i];
  return { code: code, pointsToWin: 15, winByTwo: false, bestOf: 5 };
}

// Every comp regardless of active flag - a finished comp is the most
// likely clone SOURCE, and would normally be inactive by then.
function getAllComps_(){
  var res = sbGet_('comps', 'select=comp_ref,comp_name,active&order=comp_ref.asc');
  if(!res.ok){ Logger.log('getAllComps: '+res.error); return []; }
  return res.data.map(function(c){ return { code:c.comp_ref, name:c.comp_name||c.comp_ref, active:!!c.active }; });
}

// Clone a comp's fixture SKELETON (team count, round-by-round tie pattern,
// line count, and the same relative weekly spacing) from an existing comp
// into a brand-new one. Deliberately does NOT copy roster/players - that's
// genuinely new for a new season. Use the existing Comp Players tab
// afterward to enter the real roster; saveRoster's
// applyRosterToFutureFixtures already fills player1_id/player2_id onto
// every unplayed fixture from there, so cloning only needs to set up team
// numbers/names and empty fixture shells with the right dates.
function cloneComp_(sourceComp, newComp, newCompName, startDate, outputWorkbook){
  var outputId=outputWorkbookId_(outputWorkbook);if(outputId)validateOutputWorkbook_(outputId);
  newComp = String(newComp||'').trim();
  if(!newComp) return {ok:false, error:'new comp code is required'};
  var dup = sbGet_('comps', 'select=comp_ref&comp_ref=eq.'+encodeURIComponent(newComp));
  if(dup.ok && dup.data.length) return {ok:false, error:'comp "'+newComp+'" already exists'};

  var srcRes = sbGet_('comps', 'select=comp_ref,points_per_game,win_by_two,best_of&comp_ref=eq.'+encodeURIComponent(sourceComp));
  if(!srcRes.ok || !srcRes.data.length) return {ok:false, error:'source comp not found: '+sourceComp};
  var src = srcRes.data[0];

  var srcTeamsRes = sbGet_('teams', 'select=team_id,team_no,team_name&comp_ref=eq.'+encodeURIComponent(sourceComp));
  if(!srcTeamsRes.ok) return {ok:false, error:'source teams lookup failed: '+srcTeamsRes.error};
  if(!srcTeamsRes.data.length) return {ok:false, error:'source comp has no teams to clone'};

  var srcFxRes = sbGet_('fixtures', 'select=fixture_id,round,line,scheduled,team1_id,team2_id&comp_ref=eq.'+encodeURIComponent(sourceComp));
  if(!srcFxRes.ok) return {ok:false, error:'source fixtures lookup failed: '+srcFxRes.error};
  if(!srcFxRes.data.length) return {ok:false, error:'source comp has no fixtures to clone'};

  var teamNoById={}; srcTeamsRes.data.forEach(function(t){ teamNoById[t.team_id]=t.team_no; });

  // Derive round -> day-offset-from-round-1 purely from the SOURCE
  // schedule, so the new comp keeps the exact same weekly cadence
  // (including any gaps/byes in the calendar) relative to whichever start
  // date is given here - no assumption about what day of the week it is.
  var roundDate={};
  srcFxRes.data.forEach(function(f){
    var r=parseInt(f.round,10);
    if(r && f.scheduled && roundDate[r]==null) roundDate[r]=_toDate_(f.scheduled);
  });
  var roundNos = Object.keys(roundDate).map(Number).sort(function(a,b){return a-b;});
  if(!roundNos.length) return {ok:false, error:'source fixtures have no scheduled dates to derive a calendar from'};
  var r1 = roundNos[0], r1Date = roundDate[r1];
  var offsetDays={};
  roundNos.forEach(function(r){ offsetDays[r] = Math.round((roundDate[r]-r1Date)/86400000); });

  var newStart = _toDate_(startDate);
  if(!(newStart instanceof Date)) return {ok:false, error:'invalid start date: '+startDate};
  var tz = Session.getScriptTimeZone();
  function newDateFor(r){
    var off = offsetDays[r]!=null ? offsetDays[r] : (r-r1)*7;   // fallback if a source round was missing a date: assume weekly
    var d = new Date(newStart.getFullYear(), newStart.getMonth(), newStart.getDate()+off);
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }

  var compIns = sbUpsert_('comps', [{
    comp_ref:newComp, comp_name:newCompName||newComp, active:true, output_workbook_id:outputId||null,
    points_per_game:src.points_per_game, win_by_two:src.win_by_two, best_of:src.best_of
  }]);
  if(!compIns.ok) return {ok:false, error:'comp insert failed: '+compIns.error};

  var teamRows = srcTeamsRes.data.map(function(t){ return {comp_ref:newComp, team_no:t.team_no, team_name:t.team_name}; });
  var teamIns = sbUpsert_('teams', teamRows, 'comp_ref,team_no');
  if(!teamIns.ok) return {ok:false, error:'team clone failed: '+teamIns.error};
  var newTeamsRes = sbGet_('teams', 'select=team_id,team_no&comp_ref=eq.'+encodeURIComponent(newComp));
  if(!newTeamsRes.ok) return {ok:false, error:'new teams lookup failed: '+newTeamsRes.error};
  var newTeamIdByNo={}; newTeamsRes.data.forEach(function(t){ newTeamIdByNo[t.team_no]=t.team_id; });

  var fxRows = srcFxRes.data.map(function(f){
    var m = String(f.fixture_id).match(/-M(\d+)$/); var mno = m?m[1]:'1';
    var t1no = teamNoById[f.team1_id], t2no = teamNoById[f.team2_id];
    return {
      fixture_id: newComp+'-R'+f.round+'-L'+f.line+'-M'+mno,
      comp_ref:newComp, round:f.round, line:f.line,
      scheduled: newDateFor(parseInt(f.round,10)),
      team1_id: newTeamIdByNo[t1no]||null, team2_id: newTeamIdByNo[t2no]||null,
      player1_id: null, player2_id: null, played:false
    };
  });
  var fxIns = sbUpsert_('fixtures', fxRows);
  if(!fxIns.ok) return {ok:false, error:'fixture clone failed: '+fxIns.error};

  return { ok:true, comp:newComp, teamsCloned:teamRows.length, fixturesCloned:fxRows.length,
    rounds:roundNos.length, firstRoundDate:newDateFor(r1), lastRoundDate:newDateFor(roundNos[roundNos.length-1]) };
}

// normalise a date to yyyy-MM-dd (handles Date objects and d/m/yy or d/m/yyyy strings)
function normDate_(val, tz) {
  if (val instanceof Date) return Utilities.formatDate(val, tz||'GMT', 'yyyy-MM-dd');
  var s = String(val||'').trim();
  // A full ISO timestamp WITH a time component (e.g. Supabase's
  // "2026-09-01T14:00:00+00:00") needs proper UTC->local conversion before
  // extracting the calendar date. The previous version grabbed the leading
  // digits directly - reading the UTC calendar date, not the local one -
  // which is wrong whenever the local offset pushes midnight into a
  // different day (exactly Sydney's case: UTC+10 means anything from
  // 14:00 UTC onward is already tomorrow locally). This is what caused a
  // real fixture to be missed by exactly one day.
  var iso = s.match(/^\d{4}-\d{1,2}-\d{1,2}T\d{2}:\d{2}:\d{2}/);
  if (iso) {
    var parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, tz||'GMT', 'yyyy-MM-dd');
  }
  // Bare date-only string (no time component) - no timezone conversion
  // applies, since there's no time-of-day to shift across a day boundary.
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return m[1]+'-'+pad2_(m[2])+'-'+pad2_(m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { var y=m[3]; if(y.length===2)y='20'+y; return y+'-'+pad2_(m[2])+'-'+pad2_(m[1]); }
  return '';
}
function pad2_(x){ x=String(x); return x.length<2?'0'+x:x; }
function _toDate_(val){
  if(val instanceof Date) return val;
  var s=String(val||'').trim(); if(!s) return null;
  var m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if(m){ var y=+m[3]; if(y<100)y+=2000; return new Date(y, +m[2]-1, +m[1]); }
  return null;
}
function normTeam_(s){ return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }

/* ---------- fixture resolution (authoritative names from the master) ---------- */
// Match a scanned tie (comp + scanned DATE + teams, by number OR name) to its fixtures; round is derived.
function resolveFixtures_(comp, dateStr, teamA, teamB, teamAName, teamBName) {
  var fxRes = sbGet_('fixtures', 'select=fixture_id,round,line,scheduled,team1_id,team2_id,player1_id,player2_id&comp_ref=eq.'+encodeURIComponent(comp));
  if(!fxRes.ok) return {ok:false, error:fxRes.error};
  var rows = fxRes.data;
  if(!rows.length) return {ok:true, matched:false, reason:'no fixtures found for this comp — import the draw for it'};

  var teamIds={}, playerIds={};
  rows.forEach(function(f){ if(f.team1_id)teamIds[f.team1_id]=1; if(f.team2_id)teamIds[f.team2_id]=1;
    if(f.player1_id)playerIds[f.player1_id]=1; if(f.player2_id)playerIds[f.player2_id]=1; });
  var teamInfo={}, playerNames={};
  var tids=Object.keys(teamIds);
  if(tids.length){ var tr=sbGet_('teams','select=team_id,team_no,team_name&team_id=in.('+tids.join(',')+')');
    if(tr.ok) tr.data.forEach(function(t){teamInfo[t.team_id]={no:t.team_no,name:t.team_name};}); }
  var pids=Object.keys(playerIds);
  if(pids.length){ var pr=sbGet_('players','select=player_id,name&player_id=in.('+pids.join(',')+')');
    if(pr.ok) pr.data.forEach(function(p){playerNames[p.player_id]=p.name;}); }
  function tno(id){ return id&&teamInfo[id]?teamInfo[id].no:null; }
  function tname(id){ return id&&teamInfo[id]?teamInfo[id].name:''; }
  function pname(id){ return id&&playerNames[id]?playerNames[id]:''; }

  // NOTE: assumes the Apps Script project's own Script Timezone (Project
  // Settings) matches what MASTER's spreadsheet timezone used to be
  // (Australia/Sydney) - worth a quick check, not independently verifiable
  // from here since this no longer opens MASTER at all for this purpose.
  var tz = Session.getScriptTimeZone();
  var a = parseInt(teamA,10), b = parseInt(teamB,10), want = normDate_(dateStr, tz);
  var nA = normTeam_(teamAName), nB = normTeam_(teamBName);
  var haveNums = !isNaN(a) && !isNaN(b), haveNames = !!(nA && nB);
  var compCount = rows.length, dateCount = 0, out_ = [], round = null, homeIsTeam1 = true;

  rows.forEach(function(f){
    if (want && normDate_(f.scheduled, tz) !== want) return;
    dateCount++;
    var t1n=tno(f.team1_id), t2n=tno(f.team2_id);
    var t1m=normTeam_(tname(f.team1_id)), t2m=normTeam_(tname(f.team2_id));
    var numFwd = haveNums && t1n===a && t2n===b, numRev = haveNums && t1n===b && t2n===a;
    var nameFwd = haveNames && t1m===nA && t2m===nB, nameRev = haveNames && t1m===nB && t2m===nA;
    if (!(numFwd || numRev || nameFwd || nameRev)) return;
    homeIsTeam1 = numFwd || nameFwd;
    round = parseInt(f.round,10);
    out_.push({ line:parseInt(f.line,10), id:f.fixture_id,
      team1No:t1n, team1:tname(f.team1_id), player1:pname(f.player1_id),
      team2No:t2n, team2:tname(f.team2_id), player2:pname(f.player2_id) });
  });
  out_.sort(function (x, y){ return x.line - y.line; });
  if (out_.length) return { ok:true, matched:true, lines:out_, round:round, homeIsTeam1:homeIsTeam1,
    appResults: appResultsFor_(out_.map(function(x){return x.id;})) };
  var reason;
  if (compCount === 0) reason = 'no fixtures found for this comp — import the draw for it';
  else if (dateCount === 0) reason = 'no fixtures for this comp on ' + (want||'that date') + ' — check the scanned date';
  else if (!haveNums && !haveNames) reason = 'could not read the team numbers or names from the sheet';
  else reason = 'fixtures exist on ' + want + ', but none match ' + (haveNums ? ('teams ' + a + ' v ' + b) : (teamAName + ' v ' + teamBName)) + ' — check the scanned teams';
  return { ok:true, matched:false, lines:[], reason:reason };
}

/* ---------- extraction via Gemini (key stays server-side) ---------- */
function extractSheet_(imageB64, mimeType, compCode) {
  var rules = getRules_(compCode);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) return { ok:false, error:'GEMINI_KEY not set in Script Properties' };

  var payload = {
    contents: [{ parts: [
      { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageB64 } },
      { text: buildPrompt_(rules) }
    ]}],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0,
      maxOutputTokens: 8192,                 // room for both thinking and the JSON
      thinkingConfig: { thinkingBudget: 2048 } // cap reasoning so output isn't starved
    }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + geminiModel_() +
            ':generateContent?key=' + encodeURIComponent(key);
  var res = UrlFetchApp.fetch(url, { method:'post', contentType:'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200)
    return { ok:false, error:'Gemini HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300) };

  var j;
  try { j = JSON.parse(res.getContentText()); }
  catch (e) { return { ok:false, error:'Bad Gemini response body' }; }
  var cand = j.candidates && j.candidates[0];
  if (!cand) return { ok:false, error:'No candidate returned' + (j.promptFeedback ? ' ('+JSON.stringify(j.promptFeedback)+')' : '') };
  var parts = cand.content && cand.content.parts;
  var text = (parts && parts.length) ? parts.map(function(p){ return p.text || ''; }).join('') : '';
  if (!text) return { ok:false, error:'Empty output (finishReason: ' + (cand.finishReason || '?') +
    '). The model likely ran out of tokens — raise maxOutputTokens or lower thinkingBudget, or set a lighter GEMINI_MODEL.' };

  var jsonStr = extractJson_(text);
  if (!jsonStr) return { ok:false, error:'No JSON object in output (finishReason: ' + (cand.finishReason || '?') + ')', raw: text.slice(0, 500) };
  var data;
  try { data = JSON.parse(jsonStr); }
  catch (e) { return { ok:false, error:'JSON parse failed: ' + e.message, raw: jsonStr.slice(0, 500) }; }
  return { ok:true, rules: rules, data: data };
}

// pull the first balanced {...} object out of the model's text (robust to any wrapping/thinking leak)
function extractJson_(text) {
  var start = text.indexOf('{');
  if (start < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < text.length; i++) {
    var ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); } }
  }
  return null;
}

function buildPrompt_(rules) {
  var t = rules.pointsToWin || 15;
  var best = rules.bestOf || 5;
  var gtw = Math.floor(best / 2) + 1;   // games needed to win the match
  return "You are reading a photo of a completed handwritten squash TEAM score sheet. Best of " + best +
    " games; each game is won by the first player to " + t + " points" +
    (rules.winByTwo ? " and must win by two." : " (sudden death, no win-by-two).") +
    "\nThe MATCH ends as soon as one player has won " + gtw + " games, so report ONLY the games actually played: a " + gtw + "-0 match has " + gtw + " games, " + gtw + "-1 has " + (gtw+1) + ", " + gtw + "-2 has " + (gtw+2) + ". NEVER pad with extra games, zeros, or blank rows — if only 3 games were played, return exactly 3 points values." +
    "\nLayout: a LEFT column of player blocks (home team) and a RIGHT column (away team), up to 5 lines." +
    "\nFor each block: the player NAME is handwritten at the top; the narrow 'P' column lists that player's POINTS per game top to bottom; the P TOTAL is in a box at the block's bottom-right; a G box holds the NUMBER OF GAMES that player won." +
    "\nRead the P TOTAL and the G box EXACTLY AS WRITTEN — do NOT calculate them. The G column also has a PER-GAME mark: for each game, 1 if this player WON that game, blank/dash if they lost. Return these as \"gWins\" (array of 1/0, same length and order as points) — they are a reliable check on who won each game." +
    "\nLook CLOSELY at each player NAME for any line, stroke, or scribble drawn THROUGH it. Any such strikethrough means a SUBSTITUTE played: set that player's \"struck\" to true. If a replacement name is written near it use that as \"name\"; otherwise still set struck true and read the crossed-out original. When unsure whether a name is struck, set struck true and add a note to \"uncertain\"." +
    "\nA single game score can NEVER exceed " + t + " (sudden death stops at " + t + "): if you read " + (t+1) + " or higher, it is wrong — re-read it (a common misread is " + (t+1) + " for " + t + "). A player's TOTAL also cannot exceed games-played × " + t + "." +
    "\nSCORING TALLY (most reliable): when a game's 1..15 row has numbers crossed off one-by-one, the HIGHEST number crossed off IS that game's score — treat it as authoritative and make the written P match it. BUT a single diagonal line struck through a whole row is NOT a per-number tally (it usually means the game was played elsewhere) — ignore it and rely on the written P, the TOTAL, and the G box instead." +
    "\nRead the two team NUMBERS (from the 'Team X'/'Team Y' badges), the two team NAMES (title line, left = home, right = away), and the date (DD/MM/YY, 2000s)." +
    "\nBefore finalising each block, CROSS-CHECK and CORRECT the per-game points so that: (a) they add up to the written P TOTAL; (b) the number of games the player won equals the written G box; (c) each game has exactly one player reaching " + t + " and the other lower. The written TOTAL, written G box, and crossed-off tally are more reliable than a doubtful digit — use them to FIX misread points (e.g. if the total is 31 and you read 2,6,3 that sums to 11, re-read to values that sum to 31)." +
    '\nReturn ONLY JSON: {"teamA":int|null,"teamAName":string,"teamB":int|null,"teamBName":string,"date":string,"lines":[{"line":int,"home":{"name":string,"struck":bool,"points":[int],"total":int|null,"gamesWon":int|null,"gWins":[int]},"away":{"name":string,"struck":bool,"points":[int],"total":int|null,"gamesWon":int|null,"gWins":[int]}}],"uncertain":[string]}' +
    "\nUse null only for a truly illegible digit. Do NOT flag interpretation such as the date's century.";
}

/**************************************************************************
 * PHASE 4 — staging + commit
 * Scan results go to a Staging tab; commit moves them to MatchLog/GameLog
 * only for fixtures with NO app entry (app scores win). Scan rows are keyed
 * MatchId = 'scan-<fixtureId>' so they never collide with app entries.
 **************************************************************************/
// app-entered results (MatchId NOT starting 'scan-') for the given fixtures, keyed by fixtureId
function appResultsFor_(fids) {
  var map = {};
  var want = (fids||[]).map(function(f){return String(f);});
  if(!want.length) return map;
  var query = 'select=match_id,fixture_id,player1_id,player2_id&fixture_id=in.('+want.join(',')+')';
  Logger.log('appResultsFor: querying for fids='+JSON.stringify(want));
  var mlRes = sbGet_('match_log', query);
  if(!mlRes.ok){ Logger.log('appResultsFor: query failed - '+mlRes.error); return map; }
  Logger.log('appResultsFor: raw match_log rows returned: '+JSON.stringify(mlRes.data));
  var appRows = mlRes.data.filter(function(m){ return String(m.match_id||'').indexOf('scan-')!==0; });
  Logger.log('appResultsFor: after filtering out scan- rows, '+appRows.length+' remain: '+JSON.stringify(appRows.map(function(m){return {fixture_id:m.fixture_id, match_id:m.match_id};})));
  if(!appRows.length) return map;

  var pids={}; appRows.forEach(function(m){ if(m.player1_id)pids[m.player1_id]=1; if(m.player2_id)pids[m.player2_id]=1; });
  var pidList=Object.keys(pids), names={};
  if(pidList.length){ var pr=sbGet_('players','select=player_id,name&player_id=in.('+pidList.join(',')+')');
    if(pr.ok) pr.data.forEach(function(p){names[p.player_id]=p.name;}); }

  var matchIds=appRows.map(function(m){return m.match_id;});
  var gamesByMatch={};
  if(matchIds.length){
    var glRes = sbGet_('game_log', 'select=match_id,game_no,points_p1,points_p2&match_id=in.('+matchIds.join(',')+')');
    if(glRes.ok) glRes.data.forEach(function(g_){ gamesByMatch[g_.match_id]=gamesByMatch[g_.match_id]||[]; gamesByMatch[g_.match_id][g_.game_no-1]={p1:g_.points_p1,p2:g_.points_p2}; });
  }

  appRows.forEach(function(m){
    var fid=m.fixture_id, games=gamesByMatch[m.match_id]||[];
    var p1=games.map(function(g_){return g_?g_.p1:null;}), p2=games.map(function(g_){return g_?g_.p2:null;});
    var g_=gamesSrv_(p1,p2);
    var pl1=names[m.player1_id]||'', pl2=names[m.player2_id]||'';
    map[fid]={ p1:p1, p2:p2, player1:pl1, player2:pl2,
      games1:g_[0], games2:g_[1], winner: g_[0]>g_[1]?pl1:(g_[1]>g_[0]?pl2:'') };
  });
  return map;
}
var ML_HEAD = ['MatchId','Timestamp','Date','Comp','FixtureId','Player1','Player2','GamesP1','GamesP2','Winner','ScoreLine','DurationSec','ScanLink','RallyWinners','Source','PlayerID1','PlayerID2','Sub1','Sub2'];
var GL_HEAD = ['MatchId','GameNo','Date','Comp','Player1','Player2','PointsP1','PointsP2','GameWinner','TimeStart','TimeEnd','Duration','BreakTime','Scorer','Ref','FixtureId','CommittedDatetime','ScanLink','PlayerID1','PlayerID2'];
var RL_HEAD = ['MatchId','Date','FixtureId','Game','Rally','Server','Box','P1Score','P2Score','RallyWinner'];

function ensureSheetLocal_(ss, name, head) {
  var sh = findSheet_(ss, name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(head); return sh; }
  if (sh.getLastRow() === 0) { sh.appendRow(head); return sh; }
  var lastCol = sh.getLastColumn();
  if (lastCol < head.length) { sh.getRange(1, lastCol+1, 1, head.length-lastCol).setValues([head.slice(lastCol)]); }
  return sh;
}
function hmap_(headerRow) {
  var m = {};
  headerRow.forEach(function (h, i) { m[String(h).trim().toLowerCase()] = i; });
  return m;
}
function parseInts_(str) {
  return String(str||'').split(',').map(function (x){ return parseInt(x,10); }).filter(function (n){ return !isNaN(n); });
}
function gamesSrv_(p1, p2) {
  var g1=0,g2=0,n=Math.max(p1.length,p2.length);
  for (var i=0;i<n;i++){ var a=p1[i],b=p2[i]; if(a==null||b==null)continue; if(a>b)g1++; else if(b>a)g2++; }
  return [g1,g2];
}
function deleteRowsByColValue_(sh, col1, value) {
  if (sh.getLastRow() < 2) return;
  var vals = sh.getRange(2,col1,sh.getLastRow()-1,1).getValues();
  for (var r=vals.length-1;r>=0;r--){ if(String(vals[r][0])===String(value)) sh.deleteRow(r+2); }
}
function appEnteredFixtures_(ss) {
  var out_ = {};
  var gl = findSheet_(ss,'GameLog');
  if (gl && gl.getLastRow()>1){
    var v=gl.getDataRange().getValues(), H=hmap_(v[0]);
    for(var r=1;r<v.length;r++){ var mid=String(v[r][H.matchid]||''), fid=String(v[r][H.fixtureid]||'');
      if(fid && mid.indexOf('scan-')!==0) out_[fid]=1; }
  }
  return out_;
}
function markPlayedMaster_(ss, fixtureId) {
  if (!fixtureId) return;
  var sh = findSheet_(ss,'Fixtures'); if(!sh) return;
  var v=sh.getDataRange().getValues(), H=hmap_(v[0]);
  if(H.id==null||H.played==null) return;
  for(var r=1;r<v.length;r++){ if(String(v[r][H.id])===String(fixtureId)){
    var sched = (H.scheduled!=null)?v[r][H.scheduled]:'';        // Played = the night it was scheduled/played
    sh.getRange(r+1,H.played+1).setValue(sched || new Date()); return; } }
}

function markUnplayed_(ss, fixtureId) {
  if (!fixtureId) return;
  var sh = findSheet_(ss,'Fixtures'); if(!sh) return;
  var v=sh.getDataRange().getValues(), H=hmap_(v[0]);
  if(H.id==null||H.played==null) return;
  for(var r=1;r<v.length;r++){ if(String(v[r][H.id])===String(fixtureId)){ sh.getRange(r+1,H.played+1).setValue(''); return; } }
}

function lowerHeader_(sh){ return sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim().toLowerCase();}); }
var COLALIAS = { comp:['comp','event'], committeddatetime:['committeddatetime','commiteddatetime'] };
function _nh_(s){ return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
// Build a row for the sheet's actual header. `map` keys may be lowercased header names OR
// normalized canonical names; matching is space/case-insensitive and alias-aware.
function rowFor_(headerLower, map){
  var norm={}; for(var k in map){ norm[_nh_(k)]=map[k]; }
  return headerLower.map(function(h){ var hn=_nh_(h);
    if(norm.hasOwnProperty(hn)) return norm[hn];
    for(var c in COLALIAS){ if(COLALIAS[c].indexOf(hn)>=0 && norm.hasOwnProperty(c)) return norm[c]; }
    for(var c2 in norm){ var al=COLALIAS[c2]; if(al && al.indexOf(hn)>=0) return norm[c2]; }
    return '';
  });
}

// team-level result for one tie (comp+round+M#), read back from MatchLog
// team-level result for one tie (comp+round+M#) - LIVE CUTOVER: reads from
// Supabase instead of Sheets. Same formula as getStandings' tie handling
// (1.5 each for a double-scratch, floor of 1, +2 tie-winner bonus).
function computeTie_(comp, round, tie){
  var prefix=comp+'-R'+round+'-', suffix='-M'+tie;
  var fxRes = sbGet_('fixtures', 'select=fixture_id,team1_id,team2_id&comp_ref=eq.'+encodeURIComponent(comp));
  var fids={};
  if(fxRes.ok){
    fxRes.data.forEach(function(f){
      var id=f.fixture_id;
      if(id.indexOf(prefix)===0 && id.slice(-suffix.length)===suffix) fids[id]={t1:f.team1_id,t2:f.team2_id};
    });
  }
  var teamIdSet={}; Object.keys(fids).forEach(function(id){ teamIdSet[fids[id].t1]=1; teamIdSet[fids[id].t2]=1; });
  var tidList=Object.keys(teamIdSet), teamNameById={};
  if(tidList.length){
    var tr=sbGet_('teams','select=team_id,team_name&team_id=in.('+tidList.join(',')+')');
    if(tr.ok) tr.data.forEach(function(t){ teamNameById[t.team_id]=t.team_name; });
  }
  var teamA='', teamB='', firstFid=Object.keys(fids)[0];
  if(firstFid){ teamA=teamNameById[fids[firstFid].t1]||''; teamB=teamNameById[fids[firstFid].t2]||''; }

  var aG=0,bG=0,aL=0,bL=0,scr=0;
  // NOT filtered by match_log's own comp_ref - same reasoning as getStandings:
  // that column had confirmed gaps during the backfill. The fids[] check
  // below is already correctly comp-scoped via Fixtures, so it's the
  // reliable filter here, not comp_ref.
  var mlRes = sbGet_('match_log', 'select=fixture_id,games_p1,games_p2,score_line');
  if(mlRes.ok){
    mlRes.data.forEach(function(m){
      if(!fids[m.fixture_id]) return;
      var g1=Number(m.games_p1)||0, g2=Number(m.games_p2)||0;
      var walk2=(String(m.score_line||'').indexOf('walkover')>=0||String(m.score_line||'').indexOf('scratched')>=0), dbl2=walk2&&g1===0&&g2===0;
      if(dbl2){ scr++; } else { aG+=g1; bG+=g2; if(g1>g2)aL++; else if(g2>g1)bL++; }
    });
  }
  var winner = aL>bL?teamA:(bL>aL?teamB:'');
  var aScore=aG+(winner===teamA?2:0)+1.5*scr; if(aScore===0)aScore=1;
  var bScore=bG+(winner===teamB?2:0)+1.5*scr; if(bScore===0)bScore=1;
  return {tie:tie, teamA:teamA, teamB:teamB, aGames:aG, bGames:bG, aLines:aL, bLines:bL, aScore:aScore, bScore:bScore, winner:winner, scratches:scr};
}

// RUN THIS ONCE from the Apps Script editor (Run menu > authorizeDrive) to grant Drive
// access and confirm the scan folder is writable. Approve the permission prompt when it appears.
function authorizeDrive_(){
  var fid = PropertiesService.getScriptProperties().getProperty('SCAN_FOLDER_ID');
  var folder = fid ? DriveApp.getFolderById(fid) : DriveApp.getRootFolder();
  var f = folder.createFile('court-card-auth-test.txt', 'ok', 'text/plain');
  var name = folder.getName(); f.setTrashed(true);
  var msg = 'Drive access OK. Scans will save to folder: "' + name + '"' + (fid?'':' (root — no SCAN_FOLDER_ID set)');
  Logger.log(msg);
  return msg;
}

// save the reviewed scan to Drive (lower-res jpeg) and return {url, error}
function saveScan_(b64, mime, comp, round){
  try{
    var folder, fid=propOpt_('SCAN_FOLDER_ID');
    if(fid){ folder=DriveApp.getFolderById(fid); }
    else { var it=DriveApp.getFoldersByName('Court Card Scans'); folder=it.hasNext()?it.next():DriveApp.createFolder('Court Card Scans'); }
    var blob=Utilities.newBlob(Utilities.base64Decode(b64), mime||'image/jpeg', comp+'-R'+round+'-'+new Date().getTime()+'.jpg');
    var file=folder.createFile(blob);
    try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    return {url:file.getUrl(), error:''};
  }catch(e){ return {url:'', error:String(e&&e.message||e)}; }
}

// One-click commit of the reviewed lines. No staging tab.
// Rules: app entry wins unless line.override; line.remove deletes any result for that fixture.
// attach a scan-sheet link to already-committed rows (app-scored lines) without creating a new result
function setScanLinkFor_(sh, fid, scanUrl){
  if(!sh||!scanUrl) return false;
  var v=sh.getDataRange().getValues(), H=hmap_(v[0]);
  var fc=H.fixtureid, sc=H.scanlink; if(fc==null||sc==null) return false;
  var n=0; for(var r=1;r<v.length;r++){ if(String(v[r][fc])===String(fid)){ sh.getRange(r+1, sc+1).setValue(scanUrl); n++; } }
  return n>0;
}
function commitResults_(payload) {
  var comp = payload.comp, round = payload.round, rules = getRules_(comp), gtw = Math.floor((rules.bestOf||5)/2)+1;
  var scan = payload.image ? saveScan_(payload.image, payload.mime, comp, round) : {url:'',error:''};
  var scanUrl = scan.url;
  if(payload.image&&!scanUrl)throw new Error('Scan upload failed: '+(scan.error||'No scan link returned'));

  // Which fixtures already have an APP-scored (not scan-based) result -
  // FILTERED BY COMP, not global (original version had a bug where unrelated
  // comps' app-scored results would block scanned entries in this comp).
  var appFix = {};
  var mlAllRes = sbGet_('match_log', 'select=fixture_id,match_id,comp_ref&comp_ref=eq.'+encodeURIComponent(comp));
  requireSb_(mlAllRes);
  if(mlAllRes.ok) mlAllRes.data.forEach(function(m){ if(m.fixture_id && String(m.match_id||'').indexOf('scan-')!==0) appFix[m.fixture_id]=1; });
  Logger.log('commitResults: appFix built from '+(mlAllRes.ok?mlAllRes.data.length:'FAILED')+' comp-filtered match_log rows - fixtures flagged as app-scored: '+JSON.stringify(Object.keys(appFix)));

  var cIdx = {};
  var pRes = sbGet_('players', 'select=player_id,name');
  requireSb_(pRes);
  if(pRes.ok) pRes.data.forEach(function(p){ var nm=String(p.name||'').trim(); if(nm)(cIdx[_normName_(nm)]||(cIdx[_normName_(nm)]=[])).push(p.player_id); });
  function cid(name,preferred){var nm=String(name||'').trim(),hits=cIdx[_normName_(nm)]||[];if(preferred&&hits.indexOf(preferred)>=0)return preferred;if(hits.length>1)throw new Error('Ambiguous scan player '+nm+': '+hits.join(', ')+'. Resolve the identity before committing.');return hits[0]||'';}

  var schedMap = {},fixturePlayers={};
  var fxRes = sbGet_('fixtures', 'select=fixture_id,scheduled,player1_id,player2_id&comp_ref=eq.'+encodeURIComponent(comp));
  requireSb_(fxRes);
  if(fxRes.ok) fxRes.data.forEach(function(f){ schedMap[f.fixture_id]=f.scheduled;fixturePlayers[f.fixture_id]=f; });

  var playedDate = payload.date;
  var committed=[], skipped=[], removed=[], ties={};
  function tieOf(fid){ var m=String(fid).match(/-M(\d+)$/); return m?m[1]:''; }

  // game_log has no ON DELETE CASCADE from match_log (deliberate - avoids
  // silent data loss elsewhere) - game_log rows for a match_id MUST be
  // deleted before the match_log row itself, or the delete fails on the FK.
  function removeResultFor(matchIds){
    requireSb_(sbRpc_('cc_delete_results',{p_match_ids:matchIds}));
  }
  function existingMatchIdsForFixture(fid){
    var r = sbGet_('match_log', 'select=match_id&fixture_id=eq.'+encodeURIComponent(fid));
    requireSb_(r);return r.data.map(function(m){return m.match_id;});
  }

  (payload.lines||[]).forEach(function(l){
    var fid=l.fixtureId; if(!fid){ skipped.push({line:l.line, reason:'no fixture match'}); return; }
    ties[tieOf(fid)]=1;

    if(l.appLink){
      if(appFix[fid]){
        if(!scanUrl)throw new Error('A scanned sheet is required to link this result.');
        requireSb_(sbUpdate_('match_log', 'fixture_id=eq.'+encodeURIComponent(fid), {scan_link:scanUrl}));
        existingMatchIdsForFixture(fid).forEach(function(mid){ sbUpdate_('game_log','match_id=eq.'+encodeURIComponent(mid), {scan_link:scanUrl}); });
        skipped.push({fixtureId:fid,reason:'app entry',scanLinked:true});
      } else { skipped.push({fixtureId:fid,reason:'app link requested but no app entry'}); }
      return;
    }
    if(l.remove){
      removeResultFor(existingMatchIdsForFixture(fid));
      removed.push({fixtureId:fid});
      return;
    }
    if(!l.override && appFix[fid]){
      if(!scanUrl)throw new Error('A scanned sheet is required to link this result.');
      requireSb_(sbUpdate_('match_log', 'fixture_id=eq.'+encodeURIComponent(fid), {scan_link:scanUrl}));
      skipped.push({fixtureId:fid, reason:'app entry exists', scanLinked:true});
      return;
    }
    if(!(fid in schedMap)){skipped.push({fixtureId:fid,reason:'Fixture does not belong to the selected competition'});return;}
    if(payload.homeIsTeam1===false){var originalHome=l.home;l=Object.assign({},l,{home:l.away,away:originalHome});}

    var pl1=l.home.name, pl2=l.away.name,
        p1=(l.home.points||[]).filter(function(x){return x!=null;}),
        p2=(l.away.points||[]).filter(function(x){return x!=null;}),
        date=schedMap[fid]||playedDate, mid='scan-'+fid, now=new Date(), g1,g2,winner,line;

    if(l.home.dnp||l.away.dnp){
      var dbl = l.home.dnp && l.away.dnp;
      if(l.home.dnp&&!l.away.dnp){g1=0;g2=gtw;winner=pl2;} else if(l.away.dnp&&!l.home.dnp){g1=gtw;g2=0;winner=pl1;} else {g1=0;g2=0;winner='';}
      line=g1+'-'+g2+(dbl?' (scratched)':' (walkover)');
      // no game_log rows for a walkover/scratch - matches the original exactly
    } else {
      var g_=gamesSrv_(p1,p2); g1=g_[0]; g2=g_[1]; winner=g1>g2?pl1:(g2>g1?pl2:''); line=g1+'-'+g2;
    }

    // match_log (parent) MUST be written before game_log (child) - game_log
    // has a foreign key on match_id with no auto-create, so writing game_log
    // first fails with a 23503 FK violation and the whole line gets silently
    // skipped with no visible error to the user.
    var planned=fixturePlayers[fid]||{},pid1=cid(pl1,l.home.sub?null:planned.player1_id),pid2=cid(pl2,l.away.sub?null:planned.player2_id);
    var matchRow = {override_app:!!l.override,
      match_id:mid, fixture_id:fid, comp_ref:comp, match_date:date, committed_ts:now,
      player1_id:pid1||null, player2_id:pid2||null,
      sub1:!!l.home.sub||pid1!==planned.player1_id, sub2:!!l.away.sub||pid2!==planned.player2_id,
      games_p1:g1, games_p2:g2, winner_id:winner===pl1?pid1:(winner===pl2?pid2:null), score_line:line, duration_sec:0,
      scan_link:scanUrl, source:'scan', raw_rally_history:''
    };
    var gameRows=[];

    if(!(l.home.dnp||l.away.dnp)){
      var n=Math.max(p1.length,p2.length);
      for(var i=0;i<n;i++){ var a=p1[i],b=p2[i]; if(a==null&&b==null)continue;
        gameRows.push({ match_id:mid, game_no:i+1, points_p1:a, points_p2:b,
          game_winner_id: (a>b)?(pid1||null):(b>a?(pid2||null):null),
          committed_datetime:now, scan_link:scanUrl });
      }

    }

    var saved=sbRpc_('cc_save_result',{p_match:matchRow,p_games:gameRows,p_rallies:[],p_replace:!!l.override||!appFix[fid]});
    if(!saved.ok){skipped.push({fixtureId:fid,reason:saved.error});return;}
    committed.push({ fixtureId:fid, line:l.line, player1:pl1, player2:pl2, score:line, winner:winner });
  });

  // Enrich committed entries with app-scored values for comparison
  // (deferred feature from the scan-commit bug fix session - see handoff doc)
  var appScoreMap = {};
  var appScoresRes = sbGet_('match_log', 'select=fixture_id,score_line,games_p1,games_p2,winner_id&comp_ref=eq.'+encodeURIComponent(comp)+'&match_id=not.ilike.scan-%25');
  if(appScoresRes.ok) {
    appScoresRes.data.forEach(function(m){
      appScoreMap[m.fixture_id] = {
        score_line: m.score_line,
        games_p1: m.games_p1,
        games_p2: m.games_p2,
        winner_id: m.winner_id
      };
    });
  }
  committed.forEach(function(c){
    if(appScoreMap[c.fixtureId]) {
      c.appScore = appScoreMap[c.fixtureId].score_line;
      c.appGames = [appScoreMap[c.fixtureId].games_p1, appScoreMap[c.fixtureId].games_p2];
    }
  });

  var tieResults_ = Object.keys(ties).filter(function(t){return t;}).map(function(t){ return computeTie_(comp, round, t); });
  var refresh = null;
  // Workbook output is an explicit, confirmed round action.
  return { ok:true, comp:comp, round:round, committed:committed, skipped:skipped, removed:removed, ties:tieResults_,
    scanUrl:scanUrl, scanError:scan.error, refresh:refresh,
    links:{ draw: propOpt_('DRAW_ID') ? 'https://docs.google.com/spreadsheets/d/'+propOpt_('DRAW_ID')+'/edit' : '',
            master:'https://docs.google.com/spreadsheets/d/'+prop_('MASTER_ID')+'/edit' } };
}

// which of these fixtures already have a result in the master (for an overwrite prompt)
function existingResults_(comp, fids){
  var want = (fids||[]).map(function(f){return String(f);});
  if(!want.length) return {ok:true, existing:[]};
  var res = sbGet_('match_log', 'select=fixture_id,match_id&fixture_id=in.('+want.join(',')+')');
  if(!res.ok) return {ok:false, error:res.error};
  var out_=[], seen={};
  res.data.forEach(function(m){
    var fid=String(m.fixture_id||''); if(!fid||seen[fid]) return; seen[fid]=1;
    out_.push({fixtureId:fid, source: String(m.match_id||'').indexOf('scan-')===0?'scan':'app'});
  });
  return {ok:true, existing:out_};
}

/**************************************************************************
 * PHASE 5 — standings (read-only). Team ladder + individual ladder,
 * computed from Fixtures + MatchLog for one comp.
 * Rules: team = games won +2 to the tie winner, floor 1 (scratch 1.5 NOT
 * yet applied — flagged). Individual (best-of-5) = 6/5/4/3/2/1/0 by rubber;
 * a substitute scores 0 individual points; walkover winner treated as 3-0.
 **************************************************************************/
function normNameSrv_(s){ return String(s||'').toLowerCase().replace(/[^a-z]/g,''); }

// Combine a player's rubber(s) for ONE round into a single display cell.
// A player can play more than one rubber in a round (their own scheduled match AND
// a sub appearance elsewhere) — if ANY of them was a real (non-absent) game, that
// takes priority over a sub notation; only "all absent" reads as Away, and only
// "nothing but a 0-point sub outing" reads as the bare word "sub".
function roundCellFor_(entries){
  if(!entries || !entries.length) return {kind:'none'};
  var allAbsent = entries.every(function(e){return e.absent;});
  if(allAbsent) return {kind:'away'};
  var total=0; entries.forEach(function(e){ if(!e.absent) total+=(e.ip||0); });
  if(total===0) return {kind:'sub'};
  return {kind:'value', value:total};
}
// Classify a rostered player's cell for one round: their own game (if any) takes
// priority; if they have nothing of their own AND their current line was actually
// played that round by someone else, that's a covered line -> Away (distinct from a
// genuinely blank/unplayed round, where the line itself was never played by anyone).
// Team the player actually represented in round r, per their own MatchLog history -
// falls back to their CURRENT roster team only if there's no historical record for
// that round. Needed because a player who has since moved teams must be checked
// against the team+line grid for whichever team they played for at the time, not
// the team they're on today.
function _histTno_(pData, r, tno){
  var entries = pData && pData.rounds[r];
  return (entries && entries.length && entries[0].tno) ? entries[0].tno : tno;
}
function computePlayerRoundCell_(pData, lineFixtureGrid, rp, tno, r){
  var cell = roundCellFor_(pData && pData.rounds[r]);
  if(cell.kind!=='none') return cell;
  var histTno = _histTno_(pData, r, tno);
  var actual = lineFixtureGrid && lineFixtureGrid[histTno] && lineFixtureGrid[histTno][r] && lineFixtureGrid[histTno][r][rp.line];
  if(actual && _normName_(actual)!==_normName_(rp.player)) return {kind:'away'};
  return {kind:'none'};
}


/**************************************************************************
 * COMP REPORT — same team/player-round grid as the Retro Results sheet,
 * returned as plain JSON for an in-app view (Comp Report tab) rather than
 * written into the Draw workbook. KNOWN GAP vs Retro Results: bye rounds
 * come from the Draw workbook's own 'Draw' tab (readDrawByes), which this
 * intentionally does not open - a bye round here just shows as a genuine
 * blank cell (indistinguishable from "not yet played") rather than "BYE".
 **************************************************************************/


/**************************************************************************
 * PHASE 5b — publish standings to master tabs (safe, non-destructive to
 * the draw workbook). Writes "Team Ladder <comp>" and "Individual Ladder
 * <comp>" as plain values; IMPORTRANGE these into the draw workbook.
 **************************************************************************/
function writeLadderTab_(ss, name, head, rows){
  var sh = findSheet_(ss, name); if(!sh) sh = ss.insertSheet(name); else sh.clear();
  sh.getRange(1,1,1,head.length).setValues([head]).setFontWeight('bold');
  if(rows.length) sh.getRange(2,1,rows.length,head.length).setValues(rows);
  sh.setFrozenRows(1);
  try{ sh.autoResizeColumns(1, head.length); }catch(e){}
  return sh;
}




/**************************************************************************
 * DRAW MAINTENANCE — Stage 1: structured Roster (migrate / view / edit)
 * Reads a clean "Roster" tab if present; otherwise parses the legacy
 * side-by-side "Teams" layout. Saving writes/overwrites the Roster tab.
 **************************************************************************/
function _drawSS_(){ var id=propOpt_('DRAW_ID'); if(!id) throw new Error('DRAW_ID is not set in the admin project'); return SpreadsheetApp.openById(id); }

function _teamList_(rows){
  var m={}; rows.forEach(function(r){ if(r.teamNo && r.teamNo!=='Sub' && r.teamName && !m[r.teamNo]) m[r.teamNo]=r.teamName; });
  return Object.keys(m).map(Number).sort(function(a,b){return a-b;}).map(function(n){return {no:n,name:m[n]};});
}

// Parse the legacy Teams sheet (two teams per block; player/phone in-line; line no. in col D)
function parseLegacyTeams_(sh){
  var v=sh.getDataRange().getValues(), rows=[];
  for(var r=0;r<v.length;r++){
    var a=String(v[r][0]||'').trim(), mA=a.match(/^Team\s+(\d+)$/i);
    if(!mA) continue;
    var tnoA=parseInt(mA[1],10), tnameA=String(v[r][1]||'').trim();
    var e=String(v[r][4]||'').trim(), mE=e.match(/^Team\s+(\d+)$/i);
    var tnoB=mE?parseInt(mE[1],10):null, tnameB=mE?String(v[r][5]||'').trim():'';
    for(var k=1;k<=5;k++){
      var rr=v[r+k]; if(!rr) break;
      var line=parseInt(rr[3],10)||k;
      var pA=String(rr[0]||'').trim();
      if(pA) rows.push({teamNo:tnoA,teamName:tnameA,line:line,player:pA,phone:String(rr[2]||'').trim(),captain:!!String(rr[1]||'').trim()});
      if(tnoB){ var pB=String(rr[4]||'').trim();
        if(pB) rows.push({teamNo:tnoB,teamName:tnameB,line:line,player:pB,phone:String(rr[6]||'').trim(),captain:!!String(rr[5]||'').trim()}); }
    }
    r+=5;
  }
  return rows;
}

function getRoster_(comp){
  try{
    // Teams come from the teams table directly, not derived from roster
    // rows - a comp with real teams (e.g. freshly cloned) but zero
    // rostered players yet must still offer those teams as choices when
    // adding the first player. Deriving from roster rows meant an empty
    // roster silently produced an empty team list too.
    var teamsRes = sbGet_('teams', 'select=team_id,team_no,team_name&comp_ref=eq.'+encodeURIComponent(comp));
    if(!teamsRes.ok) return {ok:false, error:teamsRes.error};
    var teamInfo={}; teamsRes.data.forEach(function(t){ teamInfo[t.team_id]={no:t.team_no,name:t.team_name}; });
    var teamsList = teamsRes.data.map(function(t){ return {no:t.team_no, name:t.team_name}; })
      .sort(function(a,b){ return a.no-b.no; });

    var rRes = sbGet_('roster', 'select=team_id,line,player_id,captain&comp_ref=eq.'+encodeURIComponent(comp));
    if(!rRes.ok) return {ok:false, error:rRes.error};
    var subsRes=sbGet_('roster_substitutes','select=player_id,line&comp_ref=eq.'+encodeURIComponent(comp));
    if(!subsRes.ok)return {ok:false,error:'Substitute pool lookup failed: '+subsRes.error};
    rRes.data=rRes.data.concat(subsRes.data.map(function(r){return {player_id:r.player_id,line:r.line,team_id:null,captain:false,isSub:true};}));

    if(!rRes.data.length){
      if(!teamsList.length) return {ok:false, error:'no teams found for '+comp+' - clone or create teams first'};
      return {ok:true, source:'structured', rows:[], teams:teamsList};
    }

    var playerIds={};
    rRes.data.forEach(function(r){ if(r.player_id)playerIds[r.player_id]=1; });
    var contacts={}; var pids=Object.keys(playerIds);
    if(pids.length){ var pr=sbGet_('players','select=player_id,name,email,phone,grade&player_id=in.('+pids.join(',')+')');
      if(!pr.ok)return {ok:false,error:'Roster contact lookup failed: '+pr.error};
      pr.data.forEach(function(p){contacts[p.player_id]={name:p.name,email:p.email,phone:p.phone,grade:p.grade};}); }

    var rows = rRes.data.map(function(r){
      var t = teamInfo[r.team_id]||{}, c = contacts[r.player_id]||{};
      return { teamNo: r.isSub?'Sub':t.no||0, teamName: r.isSub?'':t.name||'', line: r.line||0, player: c.name||'',
        playerId: r.player_id||'', email: c.email||'', phone: c.phone||'', grade: c.grade||'', captain: !!r.captain };
    });
    return {ok:true, source:'structured', rows:rows, teams:teamsList};
  }catch(e){ return {ok:false, error:String(e&&e.message||e)}; }
}

// Sync roster players to the Contacts master: add anyone missing (with a new PlayerID),
// and push email/phone edits. Contacts stays the source of truth.
function syncContacts_(rows){
 var added=0,updated=0,nameToId={},byId={},byName={},conflicts=[];
 var lookup=sbGet_('players','select=player_id,name');
 if(!lookup.ok)return {error:lookup.error};
 lookup.data.forEach(function(p){byId[p.player_id]=p;var key=_normName_(p.name);(byName[key]||(byName[key]=[])).push(p);});
 // Resolve the whole request before making contact changes. Existing IDs
 // remain authoritative when two contacts happen to have the same name.
 rows.forEach(function(row,i){
  var nm=String(row.player||'').trim();if(!nm)return;
  var key=_normName_(nm),id=String(row.playerId||'').trim(),matches=byName[key]||[];
  var where='Row '+(i+1)+' (team '+row.teamNo+', line '+row.line+'), '+nm;
  if(id){
   if(!byId[id])conflicts.push(where+': player ID '+id+' no longer exists. Reload the roster.');
   else if(_normName_(byId[id].name)!==key)conflicts.push(where+': player ID '+id+' belongs to '+byId[id].name+'. Select the intended contact again.');
  }else if(matches.length>1){
   conflicts.push(where+': multiple contacts match: '+matches.map(function(p){return p.name+' ['+p.player_id+']';}).join(', ')+'. Select a contact from the suggestions.');
  }else if(matches.length===1)row.playerId=matches[0].player_id;
 });
 if(conflicts.length)return {added:0,updated:0,nameToId:{},conflicts:conflicts,error:conflicts.join('\n')};
 for(var i=0;i<rows.length;i++){var row=rows[i],nm=String(row.player||'').trim();if(!nm)continue;
  var r;
  if(row.playerId){
   var patch={};['email','phone','grade'].forEach(function(k){if(row[k]!=null)patch[k]=String(row[k]);});
   r=Object.keys(patch).length?sbUpdate_('players','player_id=eq.'+encodeURIComponent(row.playerId),patch):{ok:true};
   r.playerId=row.playerId;
  }else{
   r=sbRpc_('cc_resolve_player',{p_name:nm,p_email:row.email==null?null:String(row.email),p_phone:row.phone==null?null:String(row.phone),p_grade:row.grade==null?null:String(row.grade)});
  }
  if(!r.ok)return {added:added,updated:updated,nameToId:nameToId,error:'Row '+(i+1)+' (team '+row.teamNo+', line '+row.line+'), '+nm+': '+r.error};
  row.playerId=r.playerId;
  nameToId[_normName_(nm)]=r.playerId;if(r.added)added++;else updated++;
 }
 return {added:added,updated:updated,nameToId:nameToId};
}
function saveRoster_(comp, rowsJson){
  try{
    var rows=(typeof rowsJson==='string')?JSON.parse(rowsJson):rowsJson;
    if(!Array.isArray(rows))return {ok:false,error:'Invalid roster rows'};
    var slots={};
    for(var i=0;i<rows.length;i++){
      var row=rows[i];if(!String(row.player||'').trim()||String(row.teamNo)==='Sub')continue;
      var slot=row.teamNo+':'+row.line;
      if(slots[slot])return {ok:false,error:'Team '+row.teamNo+', line '+row.line+' has two players: '+slots[slot]+' and '+row.player+'. Move both players to their intended lines before saving.'};
      slots[slot]=row.player;
    }


    var sync = syncContacts_(rows);
    if(sync.error) return {ok:false, error:'contact sync failed: '+sync.error, conflicts:sync.conflicts||[]};

    var result=sbRpc_('cc_save_roster',{p_comp:comp,p_rows:rows.filter(function(r){return String(r.player||'').trim();})});
    if(!result.ok)return {ok:false,error:'Roster was not changed: '+result.error};
    result.contactsAdded=sync.added;result.contactsUpdated=sync.updated;
    return result;
  }catch(e){ return {ok:false, error:String(e&&e.message||e)}; }
}


// Refresh Player1/Player2 on FUTURE (unplayed) fixtures from the roster. Played fixtures are frozen.
// Matchups and dates are untouched — only the player names per team+line change.
// Refresh player1_id/player2_id on FUTURE (unplayed) fixtures from the
// roster. Played fixtures are frozen - never touched, matching the
// original. KNOWN LIMITATION vs the Sheets version: fixtures has no
// denormalized player-name text column anymore, only player1_id/
// player2_id (foreign keys) - a roster entry naming someone who isn't a
// known Contact can no longer be stored as free text; it resolves to
// null instead of silently keeping an unresolvable name.
function applyRosterToFutureFixtures_(comp, rows){
  var rmap={}; rows.forEach(function(r){ var t=r.teamNo, l=r.line; if(t&&l&&r.player){ rmap[t]=rmap[t]||{}; rmap[t][l]=r; } });

  var teamsRes = sbGet_('teams', 'select=team_id,team_no&comp_ref=eq.'+encodeURIComponent(comp));
  if(!teamsRes.ok) return {updated:0, frozen:0, error:teamsRes.error};
  var teamNoById={};
  teamsRes.data.forEach(function(t){ teamNoById[t.team_id]=t.team_no; });

  var playersRes = sbGet_('players', 'select=player_id,name');
  if(!playersRes.ok) return {updated:0, frozen:0, error:playersRes.error};
  var idByName={},byId={}; playersRes.data.forEach(function(p){byId[p.player_id]=p;var key=_normName_(p.name);(idByName[key]||(idByName[key]=[])).push(p.player_id);});
  var identityError='';
  rows.forEach(function(r){
   if(!r.player)return;
   var hits=idByName[_normName_(r.player)]||[];
   if(!r.playerId&&hits.length===1)r.playerId=hits[0];
   if(!r.playerId||!byId[r.playerId]||_normName_(byId[r.playerId].name)!==_normName_(r.player))identityError='Cannot resolve '+r.player+' (team '+r.teamNo+', line '+r.line+'). Select an existing contact ID.';
  });
  if(identityError)return {updated:0,frozen:0,error:identityError};

  var fxRes = sbGet_('fixtures', 'select=fixture_id,comp_ref,round,line,scheduled,team1_id,team2_id,player1_id,player2_id,played&comp_ref=eq.'+encodeURIComponent(comp)+'&played=eq.false');
  if(!fxRes.ok) return {updated:0, frozen:0, error:fxRes.error};

  var toUpdate=[], updated=0;
  fxRes.data.forEach(function(f){
    var t1no=teamNoById[f.team1_id], t2no=teamNoById[f.team2_id];
    var row1=(rmap[t1no]&&rmap[t1no][f.line]), row2=(rmap[t2no]&&rmap[t2no][f.line]);
    var pid1 = row1 ? row1.playerId : undefined;
    var pid2 = row2 ? row2.playerId : undefined;
    var changed=false;
    if(pid1!==undefined && pid1!==f.player1_id) changed=true;
    if(pid2!==undefined && pid2!==f.player2_id) changed=true;
    if(changed){
      toUpdate.push({ fixture_id:f.fixture_id, comp_ref:f.comp_ref, round:f.round, line:f.line, scheduled:f.scheduled,
        team1_id:f.team1_id, team2_id:f.team2_id, played:f.played,
        player1_id: pid1!==undefined?pid1:f.player1_id, player2_id: pid2!==undefined?pid2:f.player2_id });
      updated++;
    }
  });
  var frozenRes = sbGet_('fixtures', 'select=fixture_id&comp_ref=eq.'+encodeURIComponent(comp)+'&played=eq.true');
  var frozen = frozenRes.ok ? frozenRes.data.length : 0;

  if(toUpdate.length){
    var upRes = sbUpsert_('fixtures', toUpdate);   // fixture_id is the natural PK - no on_conflict needed
    if(!upRes.ok) return {updated:0, frozen:frozen, error:upRes.error};
  }
  return {updated:updated, frozen:frozen};
}

/**************************************************************************
 * RESULTS SHEET — team-first layout, fully script-owned (rebuilt each refresh)
 * Per team: a bold "Match points" headline row on top, then the five
 * individual line rows beneath (so it never reads as a column total).
 * Absent players (sub or scratch → 0) show "Away". Team standings at foot.
 **************************************************************************/
function _round1_(v){ return Math.round(v*10)/10; }
function _nameForNo_(nn, no){ for(var k in nn){ if(nn[k]===no) return k; } return ''; }
function _fmtD_(dv, tz){
  if(dv instanceof Date) return Utilities.formatDate(dv, tz, 'd/M');
  if(typeof dv==='number' && dv>1){ var ms=Math.round((dv-25569)*86400*1000); return Utilities.formatDate(new Date(ms), tz, 'd/M'); }
  return String(dv||'');
}
// Draw "Bye" row: byes[week] = teamNo on bye that week (week = round)
function readDrawByes_(draw){
  var sh=findSheet_(draw,'Draw'); if(!sh) return {};
  var v=sh.getDataRange().getValues(), byes={};
  for(var r=0;r<v.length;r++){
    if(String(v[r][0]||'').trim().toUpperCase()==='WEEK'){
      var cols={};
      for(var c=0;c<v[r].length;c++){ var wk=v[r][c]; if(typeof wk==='number'&&wk>0) cols[c]=wk; }
      for(var rr=r+1; rr<Math.min(r+8,v.length); rr++){
        if(String(v[rr][0]||'').trim().toUpperCase()==='BYE'){
          for(var cc in cols){ var tm=v[rr][cc]; if(typeof tm==='number'&&tm>0) byes[cols[cc]]=tm; }
          break;
        }
      }
    }
  }
  return byes;
}

// Authoritative round -> date from the Draw tab (WEEK row, DATE row beneath). Week N = Round N.
function readDrawDates_(draw){
  var sh = findSheet_(draw, 'Draw'); if(!sh) return {};
  var v = sh.getDataRange().getValues(), map = {};
  for(var r=0;r<v.length;r++){
    if(String(v[r][0]||'').trim().toUpperCase()==='WEEK'){
      for(var c=0;c<v[r].length;c++){
        var wk=v[r][c];
        if(typeof wk==='number' && wk>0 && r+1<v.length){ var d=v[r+1][c]; if(d) map[wk]=d; }
      }
    }
  }
  return map;
}

// Runnable from the editor to rebuild the Results tab without a commit.
// Pass the comp code, e.g. rebuildResults('WPM202607'). With no arg it uses REBUILD_COMP script property.


/**************************************************************************
 * RESULTS SHEET — team-first layout, fully script-owned.
 * Columns: Team/Line | Player | Total | Avg | Rank | Away | R1..Rn
 * Dates come from the Draw tab (authoritative Wednesdays). Team "Match
 * points" row on top; individual lines beneath. Absent players -> "Away".
 **************************************************************************/
function buildResultsArray_(draw, s){
  var rounds = (s.rounds || []).slice();
  var dateByRound = readDrawDates_(draw);
  var byeByRound = readDrawByes_(draw);
  var STAT = 6;                                          // cols A-F before round columns
  var W = Math.max(STAT + rounds.length, 9);
  function blank(){ var a=[]; for(var i=0;i<W;i++) a.push(''); return a; }
  var nn = s.nameToNo || {}, recByNo = {};
  s.teams.forEach(function(t){ var no=nn[t.team]; if(no) recByNo[no]=t; });

  var rosterByName = {};
  (s.currentRoster||[]).forEach(function(r){ if(r.player) rosterByName[_normName_(r.player)]={teamNo:r.teamNo,teamName:r.teamName,line:r.line,player:r.player}; });
  var pr = s.playerRounds || {};

  var A = [], boldRows = [], shadeRows = [];
  var t1=blank(); t1[0]='Results \u2014 '+s.comp; A.push(t1);
  var lg=blank(); lg[0]='Team points = match result (games won +2 to the match winner, floor 1; 1.5 to each team for a double-scratch). NOT the sum of the individual points below. Away = player absent (not counted in Avg).'; A.push(lg);
  A.push(blank());

  var stTitle=blank(); stTitle[0]='TEAM STANDINGS'; A.push(stTitle); boldRows.push(A.length);
  var stHdr=blank(); stHdr[0]='Rank'; stHdr[1]='Team'; stHdr[2]='P'; stHdr[3]='W'; stHdr[4]='L'; stHdr[5]='D'; stHdr[6]='Games Won'; stHdr[7]='Games Lost'; stHdr[8]='Points';
  A.push(stHdr); boldRows.push(A.length);
  s.teams.forEach(function(t){ var row=blank();
    if(t){ var rank=1+s.teams.filter(function(x){return x.points>t.points;}).length;
      row[0]=rank; row[1]=t.team; row[2]=t.played; row[3]=t.won; row[4]=t.lost; row[5]=t.drawn; row[6]=t.gf; row[7]=t.ga; row[8]=_round1_(t.points); }
    A.push(row); });
  A.push(blank());

  var tpTitle=blank(); tpTitle[0]='TEAM POINTS'; A.push(tpTitle); boldRows.push(A.length);
  A.push(blank());
  var h=blank(); h[0]='Team'; h[2]='Total'; h[3]='Avg'; h[4]='Rank'; h[5]='Away';
  rounds.forEach(function(r,i){ h[STAT+i]='R'+r; }); A.push(h); boldRows.push(A.length);
  var dateRow=blank(); rounds.forEach(function(r,i){ var dv=dateByRound[r]; dateRow[STAT+i]=(dv==null?'':dv); }); A.push(dateRow);
  var dateRowNum = A.length;
  A.push(blank());

  var allPlayerTotals = [];
  (s.currentRoster||[]).forEach(function(rp){
    var pKey=_normName_(rp.player), pData=pr[pKey], tno=rp.teamNo, total=0, played=0;
    rounds.forEach(function(r){ if(byeByRound[r]===_histTno_(pData, r, tno)) return;
      var cell = computePlayerRoundCell_(pData, s.lineFixtureGrid, rp, tno, r);
      if(cell.kind==='sub'){ played++; } else if(cell.kind==='value'){ total+=cell.value; played++; } });
    if(played>0) allPlayerTotals.push(total);
  });
  function playerRank(total,played){ if(!played)return ''; return 1+allPlayerTotals.filter(function(x){return x>total;}).length; }

  var teamNos = Object.keys(nn).map(function(name){return nn[name];}).filter(function(v,i,a){return v && a.indexOf(v)===i;}).sort(function(a,b){return a-b;});

  // --- TEAM POINTS rows: one per team, no nested players (players now grouped by line below) ---
  teamNos.forEach(function(tno){
    var rec = recByNo[tno];
    var tname = rec ? rec.team : (_nameForNo_(nn,tno) || ('Team '+tno));
    var tPlayed=0; rounds.forEach(function(r){ if(rec&&rec.byRound&&rec.byRound[r]!=null) tPlayed++; });
    var tr = blank(); tr[0]=tname; tr[1]='Match points'; tr[2]= rec ? _round1_(rec.points) : '';
    tr[3]= (rec&&tPlayed) ? _round1_(rec.points/tPlayed) : '';
    rounds.forEach(function(r,i){ if(byeByRound[r]===tno){ tr[STAT+i]='BYE'; return; } var v = rec && rec.byRound ? rec.byRound[r] : null; tr[STAT+i] = (v!=null)? _round1_(v) : ''; });
    shadeRows.push(A.length+1); boldRows.push(A.length+1); A.push(tr);
  });
  A.push(blank());

  // --- INDIVIDUAL RESULTS, grouped by LINE (everyone who plays Line N, across every team) ---
  var individualRowCount = 0;
  for(var lineNo=1; lineNo<=5; lineNo++){
    var lt=blank(); lt[0]='Line '+lineNo; lt[2]='Total'; lt[3]='Avg'; lt[4]='Rank'; lt[5]='Away';
    rounds.forEach(function(r,i){ lt[STAT+i]='R'+r; });
    A.push(lt); boldRows.push(A.length);

    teamNos.forEach(function(tno){
      var rp = (s.currentRoster||[]).filter(function(r){ return r.teamNo===tno && r.line===lineNo; })[0];
      if(!rp) return;   // no one currently rostered to this team+line
      var pKey = _normName_(rp.player), pData = pr[pKey];
      var total=0, played=0, away=0;
      rounds.forEach(function(r){ if(byeByRound[r]===_histTno_(pData, r, tno)) return;
        var cell = computePlayerRoundCell_(pData, s.lineFixtureGrid, rp, tno, r);
        if(cell.kind==='away'){away++;} else if(cell.kind==='sub'){played++;} else if(cell.kind==='value'){total+=cell.value;played++;} });
      var lr = blank(); lr[0]=rp.player; lr[1]=rp.teamName||_nameForNo_(nn,tno)||'';
      lr[2]= played? total : ''; lr[3]= played? _round1_(total/played) : '';
      lr[4]= playerRank(total, played); lr[5]= away||'';
      rounds.forEach(function(r,i){
        if(byeByRound[r]===_histTno_(pData, r, tno)){ lr[STAT+i]='BYE'; return; }
        var cell = computePlayerRoundCell_(pData, s.lineFixtureGrid, rp, tno, r);
        if(cell.kind==='none'){ lr[STAT+i]=''; return; }
        if(cell.kind==='away'){ lr[STAT+i]='Away'; return; }
        if(cell.kind==='sub'){ lr[STAT+i]='sub'; return; }
        lr[STAT+i]=cell.value;
      });
      A.push(lr);
      individualRowCount++;
    });
    A.push(blank());
  }

  var unrostered = [];
  Object.keys(pr).forEach(function(k){ if(!rosterByName[k]) unrostered.push(pr[k]); });
  if(unrostered.length){
    var ur=blank(); ur[0]='UNROSTERED'; A.push(ur); boldRows.push(A.length);
    unrostered.sort(function(a,b){return (Object.keys(b.rounds||{}).length)-(Object.keys(a.rounds||{}).length);})
    .forEach(function(p){
      var total=0, played=0, away=0;
      Object.keys(p.rounds).forEach(function(r){ var cell=roundCellFor_(p.rounds[r]);
        if(cell.kind==='away'){away++;} else if(cell.kind==='sub'){played++;} else if(cell.kind==='value'){total+=cell.value;played++;} });
      var lr=blank(); lr[0]=''; lr[1]=p.name; lr[2]=played?total:''; lr[3]=played?_round1_(total/played):'';
      lr[4]=playerRank(total,played); lr[5]=away||'';
      rounds.forEach(function(r,i){ var cell=roundCellFor_(p.rounds[r]);
        if(cell.kind==='none'){lr[STAT+i]='';return;} if(cell.kind==='away'){lr[STAT+i]='Away';return;}
        if(cell.kind==='sub'){lr[STAT+i]='sub';return;} lr[STAT+i]=cell.value; });
      A.push(lr);
    });
    A.push(blank());
  }

  return { A:A, W:W, dateRowNum:dateRowNum, boldRows:boldRows, shadeRows:shadeRows,
    teamCount:teamNos.length, individualRowCount:individualRowCount, rosterCount:(s.currentRoster||[]).length,
    unrosteredCount:unrostered.length };
}

// Writes the Results tab. Computes the ENTIRE new layout off-sheet first and validates it looks
// legitimate BEFORE ever touching the sheet — so a bug in the computation (bad comp code, roster
// fetch failure, etc.) can never result in an emptied/blanked Results tab. Worst case it refuses
// and reports why, leaving whatever was there untouched.


/**************************************************************************
 * RETRO RESULTS — legacy flat layout, run in parallel during transition.
 * "PLAYER SCORES <year>" — one row per currently-rostered player (grouped
 * by team/line, player-follow points), round columns 1..N, TOTAL, POS
 * (POS = rank among the 7 players sharing that line number across teams —
 * i.e. the same lineRank already used on the Ladder tab).
 * "TEAM SCORES <year>" — one row per team, round columns, TOTAL, POS.
 * Same compute-first/validate/write safety as buildResultsArray.
 **************************************************************************/
/**************************************************************************
 * RETRO RESULTS — now writes INTO your hand-built template (named ranges,
 * SUM/RANK formulas, conditional formatting) rather than generating and
 * clearing the sheet. It NEVER calls .clear() and NEVER touches the TOTAL/
 * POS columns — those stay exactly as your formulas compute them. It only
 * fills the data cells: player name, line number, and the round-by-round
 * values, for both the player block and the team block.
 *
 * Row positions come from your named ranges (Line1_Names..Line5_Names,
 * Team_Names) rather than hardcoded row numbers, so it adapts if you ever
 * restructure the sheet. The round-column width is detected by reading how
 * many sequential round numbers (1,2,3…) appear in the header row, so it
 * adapts if you extend the template to more rounds — and refuses to write
 * past that boundary, so it can never spill into your TOTAL/POS formulas.
 **************************************************************************/
function _retroRoundCols_(sh, headerRow, startCol){
  var lastCol = sh.getLastColumn();
  var vals = sh.getRange(headerRow, startCol, 1, Math.max(1, lastCol-startCol+1)).getValues()[0];
  var n=0;
  for(var i=0;i<vals.length;i++){ if(typeof vals[i]==='number' && vals[i]===n+1) n++; else break; }
  return n;
}




/**************************************************************************
 * FAULT-FINDING — run auditMaster() (and auditDraw()) from the editor.
 * Logs a report to the execution log (View > Logs) and returns it.
 **************************************************************************/
function auditMaster_(){
  var ss = SpreadsheetApp.openById(prop_('MASTER_ID')), R = [];
  function log(s){ R.push(s); }
  log('=== MASTER AUDIT '+new Date()+' ===');
  ['fixtures','MatchLog','GameLog','RallyLog','Comps'].forEach(function(name){
    var sh=findSheet_(ss,name);
    if(!sh){ log('MISSING TAB: '+name); return; }
    var v=sh.getDataRange().getValues(), head=v[0];
    var used=0; for(var i=1;i<v.length;i++){ if(v[i].some(function(x){return x!==''&&x!=null;})) used++; }
    log('['+name+'] maxRows='+sh.getMaxRows()+' dataRows(nonblank)='+used+' cols='+head.length);
    log('   header: '+head.join(' | '));
  });
  // MatchLog deep checks
  var ml=findSheet_(ss,'MatchLog'); if(ml){
    var mv=ml.getDataRange().getValues(), H={}; mv[0].forEach(function(h,i){H[String(h).trim().toLowerCase()]=i;});
    var ids={}, fids={}, badDate=0, dateTypes={}, badScore=0, slInScan=0, historyInScanlink=0;
    for(var r=1;r<mv.length;r++){
      var row=mv[r], mid=row[H['matchid']]; if(!mid) continue;
      ids[mid]=(ids[mid]||0)+1;
      var fid=row[H['fixtureid']]; if(fid) fids[fid]=(fids[fid]||0)+1;
      var dt=row[H['date']]; dateTypes[dt instanceof Date?'Date':typeof dt]=(dateTypes[dt instanceof Date?'Date':typeof dt]||0)+1;
      var sl=row[H['scoreline']]; if(sl instanceof Date) badScore++;   // scoreline turned into a date
      var sc=row[H['scanlink']], rw=row[H['rallywinners']];
      if(String(sc).match(/^\d+\|?/) || String(sc).match(/^\d{2,}$/)) historyInScanlink++;   // rally data in scanlink col
    }
    log('MatchLog: duplicate MatchIds='+Object.keys(ids).filter(function(k){return ids[k]>1;}).length
        +' duplicate fixtureIds='+Object.keys(fids).filter(function(k){return fids[k]>1;}).length);
    log('MatchLog: Date column types='+JSON.stringify(dateTypes)+' (want all Date)');
    log('MatchLog: ScoreLine-as-Date rows='+badScore+' (want 0)');
    log('MatchLog: possible rally-data-in-ScanLink rows='+historyInScanlink+' (want 0)');
    // orphaned fixtureIds (no matching fixture)
    var fx=findSheet_(ss,'Fixtures'), fset={};
    if(fx){ var fv=fx.getDataRange().getValues(), FH={}; fv[0].forEach(function(h,i){FH[String(h).trim().toLowerCase()]=i;});
      for(var i=1;i<fv.length;i++){ var id=fv[i][FH['id']]; if(id)fset[id]=1; }
      var orphan=Object.keys(fids).filter(function(f){return !fset[f];});
      log('MatchLog: orphaned fixtureIds (no fixture)='+orphan.length+(orphan.length?' e.g. '+orphan.slice(0,3).join(','):''));
    }
  }
  var out_=R.join('\n'); Logger.log(out_); return out_;
}

function auditDraw_(){
  var draw=SpreadsheetApp.openById(prop_('DRAW_ID')), R=[];
  R.push('=== DRAW AUDIT '+new Date()+' ===');
  R.push('draw workbook timezone: '+draw.getSpreadsheetTimeZone());
  ['Teams','Roster','Draw','Results','Ladder'].forEach(function(n){ var sh=findSheet_(draw,n); R.push('['+n+'] '+(sh?('maxRows='+sh.getMaxRows()):'MISSING')); });
  var dates=readDrawDates_(draw), byes=readDrawByes_(draw);
  R.push('Draw dates R1..R4: '+[1,2,3,4].map(function(r){ var d=dates[r]; return r+'='+(d instanceof Date?Utilities.formatDate(d,draw.getSpreadsheetTimeZone(),'d/M/yy'):d); }).join('  '));
  R.push('Draw byes R1..R4: '+[1,2,3,4].map(function(r){return r+'='+byes[r];}).join('  '));
  var out_=R.join('\n'); Logger.log(out_); return out_;
}

/**************************************************************************
 * ONE-TIME SCHEMA MIGRATION — reshape MatchLog/GameLog/RallyLog to the
 * canonical column set, convert string dates -> real Dates, drop redundant
 * columns, trim phantom rows. BACKS UP each tab first (…_bak_<stamp>).
 * Run migrateMaster() from the editor AFTER deploying the new code.
 **************************************************************************/
function migrateMaster_(){
  var ss = SpreadsheetApp.openById(prop_('MASTER_ID')), report = [];
  var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd-HHmmss');
  var dateCanon = { date:1, timestamp:1, committeddatetime:1 };
  [['MatchLog', ML_HEAD], ['GameLog', GL_HEAD], ['RallyLog', RL_HEAD]].forEach(function(pair){
    var name = pair[0], canon = pair[1], sh = findSheet_(ss, name);
    if(!sh){ report.push(name + ': MISSING — skipped'); return; }
    var v = sh.getDataRange().getValues();
    if(v.length < 1){ report.push(name + ': empty — skipped'); return; }
    sh.copyTo(ss).setName(name + '_bak_' + stamp);            // backup first
    var oldH = v[0];
    function idxOf(cn){ cn=_nh_(cn); var al=COLALIAS[cn]||[cn];
      for(var i=0;i<oldH.length;i++){ var hn=_nh_(oldH[i]); if(hn===cn||al.indexOf(hn)>=0) return i; } return -1; }
    var midIdx = idxOf('matchid'), rows = [];
    for(var r=1;r<v.length;r++){
      var row = v[r];
      if(!row.some(function(x){return x!==''&&x!=null;})) continue;      // drop blank rows
      if(midIdx>=0 && (row[midIdx]===''||row[midIdx]==null)) continue;   // must have a MatchId
      rows.push(canon.map(function(cn){
        var i=idxOf(cn), val=(i>=0)?row[i]:'';
        var cnn=_nh_(cn);
        if(dateCanon[cnn] && val!=='' && val!=null && !(val instanceof Date)){ var d=_toDate_(val); if(d) val=d; }
        if(cnn==='scoreline' && val instanceof Date){ val=(val.getMonth()+1)+'-'+val.getDate(); }  // recover "3-1" from a mis-converted date
        return val;
      }));
    }
    sh.clear();
    sh.getRange(1,1,1,canon.length).setValues([canon]).setFontWeight('bold');
    if(rows.length) sh.getRange(2,1,rows.length,canon.length).setValues(rows);
    sh.setFrozenRows(1);
    var slc = canon.map(_nh_).indexOf('scoreline'); if(slc>=0) try{ sh.getRange(2, slc+1, Math.max(rows.length,1), 1).setNumberFormat('@'); }catch(e){}
    var extra = sh.getMaxRows() - (rows.length + 1); if(extra>0) try{ sh.deleteRows(rows.length+2, extra); }catch(e){}
    report.push(name + ': ' + rows.length + ' rows kept -> canonical; backup = ' + name + '_bak_' + stamp);
  });
  var out_ = report.join('\n'); Logger.log(out_); return out_;
}

/**************************************************************************
 * RESULTS EDITOR — list committed rubbers for a round, delete/re-open them.
 * Deletes are archived to a "Deleted" tab first (recoverable), the fixture
 * is un-marked played, and standings/Results rebuild.
 **************************************************************************/
function listRoundsWithResults_(comp){
  try{
    var fxRes = sbGet_('fixtures', 'select=fixture_id,round&comp_ref=eq.'+encodeURIComponent(comp));
    if(!fxRes.ok) return {ok:false, error:fxRes.error};
    var roundOf={}; fxRes.data.forEach(function(f){ if(f.fixture_id) roundOf[f.fixture_id]=f.round; });

    var mlRes = sbGet_('match_log', 'select=fixture_id&comp_ref=eq.'+encodeURIComponent(comp));
    if(!mlRes.ok) return {ok:false, error:mlRes.error};
    var rounds={};
    mlRes.data.forEach(function(m){ var r=roundOf[m.fixture_id]; if(r!=null && r!=='') rounds[r]=1; });
    return {ok:true, rounds:Object.keys(rounds).map(Number).sort(function(a,b){return a-b;})};
  }catch(e){return {ok:false,error:String(e&&e.message||e)};}
}

// Rally-by-rally detail for one match, for the Comp Report drill-down.
// Only ever has data for app-scored matches - a scanned entry (match_id
// starting 'scan-') never had rally_log written for it, so this legitimately
// comes back empty for those; the caller shows that as "no rally data"
// rather than an error.
function getRallyLog_(matchId){
  if(!matchId) return {ok:false, error:'no matchId'};
  var res = sbGet_('rally_log', 'select=game_no,rally_no,server_player_id,box,p1_score,p2_score,rally_winner_id&match_id=eq.'+encodeURIComponent(matchId)+'&order=game_no.asc,rally_no.asc');
  if(!res.ok) return {ok:false, error:res.error};
  if(!res.data.length) return {ok:true, rallies:[]};
  var ids={}; res.data.forEach(function(r){ if(r.server_player_id)ids[r.server_player_id]=1; if(r.rally_winner_id)ids[r.rally_winner_id]=1; });
  var idList=Object.keys(ids), names={};
  if(idList.length){ var pr=sbGet_('players','select=player_id,name&player_id=in.('+idList.join(',')+')');
    if(pr.ok) pr.data.forEach(function(p){names[p.player_id]=p.name;}); }
  var rallies = res.data.map(function(r){
    return { game:r.game_no, rally:r.rally_no, server:names[r.server_player_id]||'', box:r.box||'',
      p1:r.p1_score, p2:r.p2_score, winner:names[r.rally_winner_id]||'' };
  });
  return {ok:true, rallies:rallies};
}

function getCommittedRubbers_(comp, round){
  try{
    var fxRes = sbGet_('fixtures', 'select=fixture_id,line,round,team1_id,team2_id&comp_ref=eq.'+encodeURIComponent(comp));
    if(!fxRes.ok) return {ok:false, error:fxRes.error};
    var fmap={};
    fxRes.data.forEach(function(f){
      if(round && round!=='all' && String(f.round)!==String(round)) return;
      fmap[f.fixture_id]={line:f.line, team1_id:f.team1_id, team2_id:f.team2_id, round:f.round};
    });
    if(!Object.keys(fmap).length) return {ok:true, rubbers:[]};

    var teamIds={}; Object.keys(fmap).forEach(function(id){ teamIds[fmap[id].team1_id]=1; teamIds[fmap[id].team2_id]=1; });
    var tids=Object.keys(teamIds), teamInfo={};
    if(tids.length){ var tr=sbGet_('teams','select=team_id,team_no,team_name&team_id=in.('+tids.join(',')+')');
      if(tr.ok) tr.data.forEach(function(t){teamInfo[t.team_id]={no:t.team_no,name:t.team_name};}); }
    function tno(id){ return id&&teamInfo[id]?teamInfo[id].no:null; }
    function tname(id){ return id&&teamInfo[id]?teamInfo[id].name:''; }

    // individual points (ip) + team points per round, from the scoring engine
    var ipByFid={}, recByNo={};
    try{ var s=getStandings_(comp);
      if(s.ok){ (s.rubbers||[]).forEach(function(rb){ if(rb.fixtureId) ipByFid[rb.fixtureId]={ip1:rb.ip1,ip2:rb.ip2}; });
        var nn=s.nameToNo||{}; s.teams.forEach(function(t){ var no=nn[t.team]; if(no)recByNo[no]=t; }); } }catch(e){}
    function teamPts(no,rnd){ var rec=recByNo[no]; return (rec&&rec.byRound&&rec.byRound[rnd]!=null)?rec.byRound[rnd]:''; }

    var fids = Object.keys(fmap);
    var mlRes = sbGet_('match_log', 'select=match_id,fixture_id,player1_id,player2_id,games_p1,games_p2,winner_id,score_line,scan_link,source&fixture_id=in.('+fids.join(',')+')');
    if(!mlRes.ok) return {ok:false, error:mlRes.error};

    var playerIds={}; mlRes.data.forEach(function(m){ if(m.player1_id)playerIds[m.player1_id]=1; if(m.player2_id)playerIds[m.player2_id]=1; if(m.winner_id)playerIds[m.winner_id]=1; });
    var pidList=Object.keys(playerIds), names={};
    if(pidList.length){ var pr=sbGet_('players','select=player_id,name&player_id=in.('+pidList.join(',')+')');
      if(pr.ok) pr.data.forEach(function(p){names[p.player_id]=p.name;}); }

    var matchIds = mlRes.data.map(function(m){return m.match_id;});
    var gmap={};
    if(matchIds.length){
      var glRes = sbGet_('game_log', 'select=match_id,game_no,points_p1,points_p2&match_id=in.('+matchIds.join(',')+')');
      if(glRes.ok) glRes.data.forEach(function(g_){ gmap[g_.match_id]=gmap[g_.match_id]||[]; gmap[g_.match_id][g_.game_no-1]={p1:g_.points_p1,p2:g_.points_p2}; });
    }

    var out_ = mlRes.data.map(function(m){
      var f=fmap[m.fixture_id]; if(!f) return null;
      var ip=ipByFid[m.fixture_id]||{};
      return { fixtureId:m.fixture_id, matchId:m.match_id, line:f.line,
        team1:tname(f.team1_id), team2:tname(f.team2_id), team1No:tno(f.team1_id), team2No:tno(f.team2_id), round:f.round,
        player1:names[m.player1_id]||'', player2:names[m.player2_id]||'',
        ip1:(ip.ip1!=null?ip.ip1:''), ip2:(ip.ip2!=null?ip.ip2:''),
        team1Pts:teamPts(tno(f.team1_id),f.round), team2Pts:teamPts(tno(f.team2_id),f.round),
        score:(Number(m.games_p1)||0)+'-'+(Number(m.games_p2)||0),
        winner:names[m.winner_id]||'',
        scanLink:m.scan_link||'',
        games:(gmap[m.match_id]||[]).filter(function(x){return x;}),
        source:m.source||(String(m.match_id||'').indexOf('scan-')===0?'scan':'app') };
    }).filter(function(x){return x;});
    out_.sort(function(a,b){return (Number(a.line)||0)-(Number(b.line)||0);});
    return {ok:true, rubbers:out_};
  }catch(e){return {ok:false,error:String(e&&e.message||e)};}
}

function deleteRubbers_(selectionsJson){
  try{
    var sels=(typeof selectionsJson==='string')?JSON.parse(selectionsJson):selectionsJson;
    if(!sels||!sels.length) return {ok:false,error:'nothing selected'};
    var stamp=new Date(), deleted=0;
    var midSet={}, fidSet={};
    sels.forEach(function(s){ if(typeof s==='string'){midSet[s]=1;fidSet[s]=1;} else {if(s.matchId)midSet[s.matchId]=1; if(s.fixtureId)fidSet[s.fixtureId]=1;} });
    var mids = Object.keys(midSet);

    // Archive to the Sheets 'Deleted' tab first (safety net, same promise the
    // confirm() dialog makes) - archival log only, not a live data source, so
    // Sheets is fine for this.
    if(mids.length){
      var ml0 = sbGet_('match_log', 'select=*&match_id=in.('+mids.join(',')+')');
      var gl0 = sbGet_('game_log', 'select=*&match_id=in.('+mids.join(',')+')');
      var rl0 = sbGet_('rally_log', 'select=*&match_id=in.('+mids.join(',')+')');
      requireSb_(ml0);requireSb_(gl0);requireSb_(rl0);
      var arch=[];
      if(ml0.ok) ml0.data.forEach(function(row){ arch.push([stamp,'match_log',JSON.stringify(row)]); });
      if(gl0.ok) gl0.data.forEach(function(row){ arch.push([stamp,'game_log',JSON.stringify(row)]); });
      if(rl0.ok) rl0.data.forEach(function(row){ arch.push([stamp,'rally_log',JSON.stringify(row)]); });
      if(arch.length){
        var ss=SpreadsheetApp.openById(prop_('MASTER_ID'));
        var ded=findSheet_(ss,'Deleted')||ss.insertSheet('Deleted');
        if(ded.getLastRow()===0) ded.appendRow(['DeletedAt','Tab','RowJSON']);
        ded.getRange(ded.getLastRow()+1,1,arch.length,3).setValues(arch);
      }
      deleted = arch.length;

      // Delete child rows before parent (rally_log/game_log reference match_log
      // by match_id - the same FK-order lesson from the commitResults fix).
      requireSb_(sbRpc_('cc_delete_results',{p_match_ids:mids}));
    }

    // Only unmark a fixture as played if NO remaining match_log rows exist for it.
    Object.keys(fidSet).forEach(function(fid){ if(!fid)return;
      var chk = sbGet_('match_log', 'select=match_id&fixture_id=eq.'+encodeURIComponent(fid));
      if(chk.ok && chk.data.length===0) sbUpdate_('fixtures', 'fixture_id=eq.'+encodeURIComponent(fid), {played:false});
    });

    var refresh='Output requires a new confirmed round export after corrections',refreshError=null;
    return {ok:true, deletedRows:deleted, fixtures:sels.length, refresh:refresh, refreshError:refreshError};
  }catch(e){return {ok:false,error:String(e&&e.message||e)};}
}

/**************************************************************************
 * PLAYER IDENTITY — Contacts tab is the intercomp identity spine.
 * Schema: PlayerID | Name | Email | Phone   (PlayerID auto-assigned, stable)
 **************************************************************************/
function _normName_(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' ').replace(/[^a-z0-9 ]/g,''); }

// Create the Contacts tab if missing; stamp a stable PlayerID on any row that has a Name but no ID.
function ensureContactIds_(){
  var ss=SpreadsheetApp.openById(prop_('MASTER_ID'));
  var sh=findSheet_(ss,'Contacts');
  if(!sh){ sh=ss.insertSheet('Contacts'); sh.getRange(1,1,1,4).setValues([['PlayerID','Name','Email','Phone']]).setFontWeight('bold'); sh.setFrozenRows(1);
    return {ok:true, created:true, assigned:0, message:'Created Contacts tab. Add Name / Email / Phone, then run ensureContactIds() again to assign PlayerIDs.'}; }
  var v=sh.getDataRange().getValues(), H=hmap_(v[0]);
  if(H.playerid==null || H.name==null) return {ok:false, error:'Contacts tab needs PlayerID and Name columns'};
  var maxN=0;
  for(var r=1;r<v.length;r++){ var m=String(v[r][H.playerid]||'').match(/(\d+)/); if(m){ var n=parseInt(m[1],10); if(n>maxN)maxN=n; } }
  var assigned=0;
  for(var r=1;r<v.length;r++){ var name=String(v[r][H.name]||'').trim(), id=String(v[r][H.playerid]||'').trim();
    if(name && !id){ maxN++; sh.getRange(r+1, H.playerid+1).setValue('P'+('0000'+maxN).slice(-4)); assigned++; } }
  return {ok:true, assigned:assigned, total:v.length-1};
}

function getContacts_(){
  var res = sbGet_('players', 'select=player_id,name,email,phone,grade');
  if(!res.ok) return {ok:false, error:res.error};
  var out_ = res.data.map(function(p){ return { id:p.player_id||'', name:p.name||'', email:p.email||'', phone:p.phone||'', grade:p.grade||'' }; });
  return {ok:true, contacts:out_};
}

// Report which player names in MatchLog + Roster are (not) present in Contacts, so nothing is silently orphaned.
function reconcileNames_(){
  var ss=SpreadsheetApp.openById(prop_('MASTER_ID'));
  var byNorm={};
  var cs=findSheet_(ss,'Contacts');
  if(cs){ var cv=cs.getDataRange().getValues(), CH=hmap_(cv[0]); for(var r=1;r<cv.length;r++){ var nm=String(cv[r][CH.name]||'').trim(); if(nm) byNorm[_normName_(nm)]={name:nm, id:String(cv[r][CH.playerid]||'')}; } }
  var names={};
  var ml=findSheet_(ss,'MatchLog');
  if(ml){ var mv=ml.getDataRange().getValues(), MH=hmap_(mv[0]); for(var r=1;r<mv.length;r++){ [mv[r][MH.player1],mv[r][MH.player2]].forEach(function(n){ var nm=String(n||'').trim(); if(nm) names[_normName_(nm)]=nm; }); } }
  try{ var draw=SpreadsheetApp.openById(prop_('DRAW_ID')); var rs=findSheet_(draw,'Roster');
    if(rs){ var rv=rs.getDataRange().getValues(), RH=hmap_(rv[0]); for(var r=1;r<rv.length;r++){ var nm=String(rv[r][RH.player]||'').trim(); if(nm) names[_normName_(nm)]=nm; } } }catch(e){}
  var matched=[], unmatched=[];
  Object.keys(names).forEach(function(k){ if(byNorm[k]) matched.push(names[k]); else unmatched.push(names[k]); });
  var report='=== NAME RECONCILIATION ===\nContacts: '+Object.keys(byNorm).length+
    '\nDistinct players in MatchLog+Roster: '+Object.keys(names).length+
    '\nMatched to a contact: '+matched.length+
    '\nNOT in Contacts ('+unmatched.length+'): '+unmatched.sort().join(', ');
  Logger.log(report); return {ok:true, matched:matched.length, unmatched:unmatched.sort(), report:report};
}

/**************************************************************************
 * STAMP PLAYER IDS — one-time reconciliation. Appends PlayerID columns to
 * MatchLog/GameLog/Fixtures (PlayerID1/PlayerID2) and Roster (PlayerID),
 * filling them from Contacts by name. Additive: never edits existing data.
 **************************************************************************/
function _contactIndex_(ss){
  var cs=findSheet_(ss,'Contacts'); var idx={};
  if(!cs) return idx;
  var v=cs.getDataRange().getValues(), H=hmap_(v[0]);
  for(var r=1;r<v.length;r++){ var nm=String(v[r][H.name]||'').trim(), id=String(v[r][H.playerid]||'').trim(); if(nm&&id) idx[_normName_(nm)]=id; }
  return idx;
}
function stampPlayerIds_(){
  var ss=SpreadsheetApp.openById(prop_('MASTER_ID'));
  var idx=_contactIndex_(ss);
  if(!Object.keys(idx).length) return {ok:false, error:'no Contacts with IDs — run ensureContactIds first'};
  var unmatched={}, report=[];
  function idOf(name){ var nm=String(name||'').trim(); if(!nm)return ''; var id=idx[_normName_(nm)]; if(!id){unmatched[nm]=1;return '';} return id; }
  function stamp(sh, pairs){
    if(!sh){ report.push('(missing tab)'); return; }
    var v=sh.getDataRange().getValues(); if(v.length<2){ report.push(sh.getName()+': empty'); return; }
    var head=v[0].map(String), lc=head.map(function(h){return h.trim().toLowerCase();});
    pairs.forEach(function(p){ if(lc.indexOf(p.id.toLowerCase())<0){ head.push(p.id); lc.push(p.id.toLowerCase()); } });
    sh.getRange(1,1,1,head.length).setValues([head]);
    var filled=0;
    pairs.forEach(function(p){ var ni=lc.indexOf(p.name.toLowerCase()), ii=lc.indexOf(p.id.toLowerCase()); if(ni<0||ii<0)return;
      var col=[]; for(var r=1;r<v.length;r++){ var id=idOf(v[r][ni]); col.push([id]); if(id)filled++; }
      sh.getRange(2, ii+1, col.length, 1).setValues(col); });
    report.push(sh.getName()+': '+filled+' ids filled across '+(v.length-1)+' rows');
  }
  stamp(findSheet_(ss,'MatchLog'), [{name:'player1',id:'PlayerID1'},{name:'player2',id:'PlayerID2'}]);
  stamp(findSheet_(ss,'GameLog'),  [{name:'player1',id:'PlayerID1'},{name:'player2',id:'PlayerID2'}]);
  stamp(findSheet_(ss,'Fixtures'), [{name:'player1',id:'PlayerID1'},{name:'player2',id:'PlayerID2'}]);
  try{ var draw=SpreadsheetApp.openById(prop_('DRAW_ID')); stamp(findSheet_(draw,'Roster'), [{name:'player',id:'PlayerID'}]); }catch(e){ report.push('Roster: '+e.message); }
  var un=Object.keys(unmatched).sort();
  var out_='=== STAMP PLAYER IDS ===\n'+report.join('\n')+'\nUNMATCHED names ('+un.length+'): '+un.join(', ');
  Logger.log(out_); return {ok:true, unmatched:un, report:out_};
}

/**************************************************************************
 * CLEANUP SUB FLAGS — one-time. Backfills MatchLog Sub1/Sub2 from the
 * legacy GameLog values, backs up GameLog, then removes Sub1/Sub2 from
 * GameLog. Fixtures are intentionally untouched (they hold the ROSTERED
 * player; sub detection depends on played-vs-rostered mismatch).
 **************************************************************************/
function cleanupSubs_(){
  var ss=SpreadsheetApp.openById(prop_('MASTER_ID'));
  var gl=findSheet_(ss,'GameLog'), ml=findSheet_(ss,'MatchLog');
  if(!gl||!ml) return {ok:false,error:'missing GameLog/MatchLog'};
  var stamp=Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd-HHmmss');
  function truthy(x){ return x===true || String(x).trim().toLowerCase()==='true'; }
  // 1. collect sub flags per MatchId from GameLog
  var gv=gl.getDataRange().getValues(), GH=hmap_(gv[0]), subByMid={};
  for(var r=1;r<gv.length;r++){ var mid=String(gv[r][GH.matchid]||''); if(!mid)continue;
    var e=subByMid[mid]||(subByMid[mid]={s1:false,s2:false});
    if(GH.sub1!=null && truthy(gv[r][GH.sub1])) e.s1=true;
    if(GH.sub2!=null && truthy(gv[r][GH.sub2])) e.s2=true; }
  // 2. ensure MatchLog has Sub1/Sub2 columns
  function ensureCol(sh,name){ var hdr=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim().toLowerCase();});
    if(hdr.indexOf(name.toLowerCase())<0) sh.getRange(1,sh.getLastColumn()+1).setValue(name); }
  ensureCol(ml,'Sub1'); ensureCol(ml,'Sub2');
  // 3. backfill MatchLog where blank
  var mv=ml.getDataRange().getValues(), MH=hmap_(mv[0]), filled=0;
  for(var r=1;r<mv.length;r++){ var mid=String(mv[r][MH.matchid]||''), sb=subByMid[mid]; if(!sb)continue;
    if(MH.sub1!=null && !truthy(mv[r][MH.sub1]) && sb.s1){ ml.getRange(r+1,MH.sub1+1).setValue(true); filled++; }
    if(MH.sub2!=null && !truthy(mv[r][MH.sub2]) && sb.s2){ ml.getRange(r+1,MH.sub2+1).setValue(true); filled++; } }
  // 4. backup GameLog, then delete its Sub1/Sub2 columns (right-to-left)
  gl.copyTo(ss).setName('GameLog_bak_'+stamp);
  var gHdr=gl.getRange(1,1,1,gl.getLastColumn()).getValues()[0].map(function(h){return String(h).trim().toLowerCase();});
  var cols=[]; gHdr.forEach(function(h,i){ if(h==='sub1'||h==='sub2')cols.push(i+1); });
  cols.sort(function(a,b){return b-a;}).forEach(function(c){ gl.deleteColumn(c); });
  var out_='Sub cleanup — MatchLog flags backfilled: '+filled+'; GameLog Sub columns removed: '+cols.length+'; backup: GameLog_bak_'+stamp;
  Logger.log(out_); return {ok:true, backfilled:filled, removed:cols.length, backup:'GameLog_bak_'+stamp, report:out_};
}

/**************************************************************************
 * DIAGNOSTIC — dump the raw per-round rubber data collected for one player,
 * so an "Away not showing" (or similar) report can be traced exactly rather
 * than guessed at. Run from the editor: debugPlayerRounds('WPM202607','Debbie Turner')
 **************************************************************************/
function debugPlayerRounds_(comp, playerName){
  var s = getStandings_(comp);
  if(!s.ok){ Logger.log('getStandings failed: '+s.error); return s; }
  var key = _normName_(playerName);
  var pData = (s.playerRounds||{})[key];
  var rc = (s.currentRoster||[]).filter(function(r){ return _normName_(r.player)===key; });
  var out_ = 'Player: '+playerName+'  (normalized key: '+key+')\n';
  out_ += 'On current roster as: '+(rc.length?JSON.stringify(rc):'NOT FOUND on any current roster — this is why it would render blank, not Away')+'\n';
  if(!pData){ out_ += 'No playerRounds entry at all for this name — either they have zero committed results, or the name in MatchLog never matches this key.'; Logger.log(out_); return {ok:true, note:'no data'}; }
  var rounds = Object.keys(pData.rounds).map(Number).sort(function(a,b){return a-b;});
  rounds.forEach(function(r){
    var entries = pData.rounds[r];
    var cell = roundCellFor_(entries);
    out_ += 'Round '+r+': '+entries.length+' rubber(s) -> '+JSON.stringify(entries)+'  => cell = '+JSON.stringify(cell)+'\n';
  });
  Logger.log(out_);
  return {ok:true, rounds:rounds, raw:pData.rounds};
}

/**************************************************************************
 * QUICK-RUN WRAPPERS — zero-argument helpers so they show up directly in
 * the Apps Script editor's function dropdown (Run only works on functions
 * with no arguments). Update the comp code here if it ever changes.
 **************************************************************************/
function rebuildWPM_(){ return rebuildResults_('WPM202607'); }
function debugDebbieTurner_(){ return debugPlayerRounds_('WPM202607', 'Debbie Turner'); }
function debugMichaelJones_(){ return debugPlayerRounds_('WPM202607', 'Michael Jones'); }

// Walks every fixture for one team+line across ALL rounds and shows whether a MatchLog
// row exists for it and what's in it — reveals rounds with no result at all (nothing
// ever committed) vs a result that exists but isn't joining (fixtureId mismatch).
function auditTeamLine_(comp, teamNo, line){
  var ss = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var fx = findSheet_(ss,'Fixtures'), ml = findSheet_(ss,'MatchLog');
  if(!fx){ Logger.log('no Fixtures tab'); return {ok:false}; }
  var fv = fx.getDataRange().getValues(), FH = hmap_(fv[0]);
  var mv = (ml && ml.getLastRow()>1) ? ml.getDataRange().getValues() : [], MH = ml? hmap_(mv[0]||[]) : {};
  var mlByFid = {};
  for(var r=1;r<mv.length;r++){ var fid=String(mv[r][MH.fixtureid]||''); if(fid){ mlByFid[fid]=mlByFid[fid]||[]; mlByFid[fid].push(mv[r]); } }
  var rows = [];
  for(var r2=1;r2<fv.length;r2++){
    if(String(fv[r2][FH.comp]).trim()!==String(comp).trim()) continue;
    var ln = parseInt(fv[r2][FH.line],10);
    var t1no = parseInt(fv[r2][FH['team1no']],10), t2no = parseInt(fv[r2][FH['team2no']],10);
    if(ln!==line || (t1no!==teamNo && t2no!==teamNo)) continue;
    rows.push({ round:fv[r2][FH.round], id:String(fv[r2][FH.id]), p1:fv[r2][FH.player1], p2:fv[r2][FH.player2],
      t1:fv[r2][FH.team1], t2:fv[r2][FH.team2], played:fv[r2][FH.played] });
  }
  rows.sort(function(a,b){ return (+a.round)-(+b.round); });
  var out_ = 'Fixtures for team '+teamNo+' line '+line+' in '+comp+' ('+rows.length+' rounds):\n';
  rows.forEach(function(fr){
    var mrows = mlByFid[fr.id]||[];
    out_ += 'Round '+fr.round+'  ['+fr.id+']  '+fr.t1+' v '+fr.t2+'  ('+fr.p1+' v '+fr.p2+')  Played='+fr.played+'\n';
    if(!mrows.length) out_ += '    -> NO MatchLog row for this fixture (nothing committed)\n';
    mrows.forEach(function(mr){
      out_ += '    -> MatchLog: Player1='+mr[MH.player1]+' Player2='+mr[MH.player2]+
        ' Games='+mr[MH.gamesp1]+'-'+mr[MH.gamesp2]+' ScoreLine="'+mr[MH.scoreline]+'"'+
        ' Comp='+(MH.comp!=null?mr[MH.comp]:mr[MH.event])+'\n';
    });
  });
  Logger.log(out_);
  return { ok:true, count:rows.length, rows:rows };
}
function auditKillarneyL1_(){ return auditTeamLine_('WPM202607', 1, 1); }

// Identity-based scoring shared by the report and confirmed workbook exports.
function buildCompetitionStandings_(data, rules){
 var fx=data.fixtures, roster=data.roster, ps={}, ts={}, results={}, warnings=[];
 data.players.forEach(function(p){ps[p.player_id]=p.name;});
 data.teams.forEach(function(t){ts[t.team_id]=t;});
 data.matches.forEach(function(m){results[m.fixture_id]=m;});
 var teamNos=data.teams.map(function(t){return t.team_no;}).sort(function(a,b){return a-b;});
 var nn={}, teams={}, individuals={}, playerRounds={}, rubbers=[], ties={}, rounds={}, scheduled={}, participation={};
 data.teams.forEach(function(t){nn[t.team_name]=t.team_no;teams[t.team_no]={team:t.team_name,teamNo:t.team_no,played:0,won:0,lost:0,drawn:0,gf:0,ga:0,points:0,byRound:{}};});
 fx.forEach(function(f){
  var r=Number(f.round);rounds[r]=f.scheduled; participation[r]=participation[r]||{};
  [1,2].forEach(function(side){var tid=f['team'+side+'_id'],pid=f['player'+side+'_id'];if(ts[tid])participation[r][ts[tid].team_no]=true;
   if(pid){scheduled[pid]=scheduled[pid]||{};scheduled[pid][r]=scheduled[pid][r]||[];scheduled[pid][r].push({fixture:f,side:side});}});
 });
 var byes={};Object.keys(rounds).forEach(function(r){var missing=teamNos.filter(function(t){return !participation[r][t];});
  // Infer a bye only when a complete round uses every other team.
  if(teamNos.length%2===1&&missing.length===1)byes[r]=missing[0];
 });
 fx.forEach(function(f){var m=results[f.fixture_id];if(!m){if(f.played)warnings.push('Played fixture has no saved result: '+f.fixture_id);return;}var r=Number(f.round),g1=Number(m.games_p1)||0,g2=Number(m.games_p2)||0;
  var walk=/walkover|scratched/i.test(m.score_line||''), dbl=walk&&g1===0&&g2===0;
  var t1=ts[f.team1_id],t2=ts[f.team2_id];if(!t1||!t2){warnings.push('Missing team: '+f.fixture_id);return;}
  var key=r+':'+f.team1_id+':'+f.team2_id,t=ties[key]||(ties[key]={r:r,a:t1.team_no,b:t2.team_no,ga:0,gb:0,wa:0,wb:0,scr:0,count:0,expected:fx.filter(function(x){return Number(x.round)===r&&x.team1_id===f.team1_id&&x.team2_id===f.team2_id;}).length});
  t.count++;if(dbl)t.scr++;else{t.ga+=g1;t.gb+=g2;if(g1>g2)t.wa++;if(g2>g1)t.wb++;}
  var rb={fixtureId:f.fixture_id,round:r,line:Number(f.line),t1no:t1.team_no,t2no:t2.team_no,p1Actual:ps[m.player1_id]||'',p2Actual:ps[m.player2_id]||'',ip1:0,ip2:0};
  [1,2].forEach(function(side){var pid=f['player'+side+'_id'];if(!pid)return;
   var actual=m['player'+side+'_id'],g=side===1?g1:g2,opp=side===1?g2:g1;
   var eligible=actual===pid&&!m['sub'+side],absent=!eligible||(walk&&g===0);
   var entries=scheduled[pid][r],cell={kind:'away'};
   if(entries.length>1){cell={kind:'conflict'};warnings.push('Player '+pid+' has multiple scheduled matches in round '+r);}
   else if(!absent)cell={kind:'value',value:g>opp?6-opp:1+g};
   playerRounds[pid]=playerRounds[pid]||{name:ps[pid]||pid,rounds:{}};playerRounds[pid].rounds[r]=cell;
   if(cell.kind==='value'){
    rb['ip'+side]=cell.value;var ti=side===1?t1:t2;
    var p=individuals[pid]||(individuals[pid]={playerId:pid,player:ps[pid]||pid,team:ti.team_name,played:0,won:0,lost:0,points:0,lines:{}});
    p.played++;p.points+=cell.value;if(g>opp)p.won++;else p.lost++;p.lines[f.line]=1;
   }
  });rubbers.push(rb);
 });
 Object.keys(ties).forEach(function(k){var t=ties[k];if(t.count!==t.expected){warnings.push('Incomplete team tie in round '+t.r+' ('+t.count+'/'+t.expected+' results)');return;}
  var pa=t.ga+(t.wa>t.wb?2:0)+1.5*t.scr,pb=t.gb+(t.wb>t.wa?2:0)+1.5*t.scr;pa=pa||1;pb=pb||1;
  var a=teams[t.a],b=teams[t.b];a.byRound[t.r]=pa;b.byRound[t.r]=pb;a.points+=pa;b.points+=pb;a.played++;b.played++;a.gf+=t.ga;a.ga+=t.gb;b.gf+=t.gb;b.ga+=t.ga;
  if(t.wa>t.wb){a.won++;b.lost++;}else if(t.wb>t.wa){b.won++;a.lost++;}else{a.drawn++;b.drawn++;}
 });
 var currentRoster=roster.filter(function(p){return p.player_id&&ts[p.team_id];}).map(function(p){var t=ts[p.team_id];return {playerId:p.player_id,player:ps[p.player_id]||p.player_id,teamNo:t.team_no,teamName:t.team_name,line:Number(p.line)};});
 var inds=Object.keys(individuals).map(function(k){return individuals[k];}).sort(function(a,b){return b.points-a.points||b.won-a.won;});
 inds.forEach(function(p){p.line=Object.keys(p.lines).map(function(l){return 'L'+l;}).join(',');p.compRank=1+inds.filter(function(x){return x.points>p.points;}).length;p.lineRank=1+inds.filter(function(x){return x.points>p.points&&Object.keys(x.lines)[0]===Object.keys(p.lines)[0];}).length;});
 return {ok:true,comp:data.comp,teams:Object.keys(teams).map(function(k){return teams[k];}).sort(function(a,b){return b.points-a.points;}),individuals:inds,rounds:Object.keys(rounds).map(Number).sort(function(a,b){return a-b;}),dateByRound:rounds,byes:byes,scheduled:scheduled,playerRounds:playerRounds,currentRoster:currentRoster,nameToNo:nn,teamNos:teamNos,rubbers:rubbers,warnings:warnings,rosterError:'',scratches:0,notes:{individual:'Only the scheduled match earns individual points; substitutes contribute to their team only',scratch:'double scratches give each team 1.5 points'}};
}
function loadCompetitionData_(comp){
 function get(t,q){return requireSb_(sbGet_(t,q)).data;}
 return {comp:comp,fixtures:get('fixtures','select=*&comp_ref=eq.'+encodeURIComponent(comp)),matches:get('match_log','select=fixture_id,player1_id,player2_id,games_p1,games_p2,score_line,sub1,sub2,scan_link,match_id&comp_ref=eq.'+encodeURIComponent(comp)),teams:get('teams','select=*&comp_ref=eq.'+encodeURIComponent(comp)),roster:get('roster','select=*&comp_ref=eq.'+encodeURIComponent(comp)),players:get('players','select=player_id,name')};
}
function getStandings_(comp){return buildCompetitionStandings_(loadCompetitionData_(comp),getRules_(comp));}
function scheduledPlayerCell_(s,rp,r){
 var scheduled=s.scheduled[rp.playerId]&&s.scheduled[rp.playerId][r];
 if(scheduled&&scheduled.length>1)return 'CHECK';
 if(scheduled&&scheduled.some(function(x){return x.fixture.played;})&&!(s.playerRounds[rp.playerId]&&s.playerRounds[rp.playerId].rounds[r]))return 'CHECK';
 var cell=s.playerRounds[rp.playerId]&&s.playerRounds[rp.playerId].rounds[r];
 if(cell)return cell.kind==='value'?cell.value:(cell.kind==='conflict'?'CHECK':'AWAY');
 if(!scheduled&&s.byes[r]===rp.teamNo)return 'BYE';
 return '';
}
function reportFromStandings_(s){
 var totals=[];var lines=[];
 for(var l=1;l<=5;l++){
  var rows=s.currentRoster.filter(function(p){return p.line===l;}).sort(function(a,b){return a.teamNo-b.teamNo;}).map(function(p){
   var cells=s.rounds.map(function(r){return scheduledPlayerCell_(s,p,r);}),nums=cells.filter(function(v){return typeof v==='number';}),total=nums.reduce(function(a,b){return a+b;},0);
   var row={playerId:p.playerId,player:p.player,team:p.teamName,teamNo:p.teamNo,total:nums.length?total:'',avg:nums.length?_round1_(total/nums.length):'',away:cells.filter(function(v){return v==='AWAY';}).length||'',byRound:cells};if(nums.length)totals.push(total);return row;
  });lines.push({line:l,rows:rows});
 }
 lines.forEach(function(l){l.rows.forEach(function(p){p.rank=p.total===''?'':1+totals.filter(function(v){return v>p.total;}).length;});});
 return {ok:true,comp:s.comp,rounds:s.rounds,lines:lines,warnings:s.warnings,teams:s.teams.slice().sort(function(a,b){return a.teamNo-b.teamNo;}).map(function(t){return {teamNo:t.teamNo,team:t.team,points:t.points,avg:t.played?_round1_(t.points/t.played):'',byRound:s.rounds.map(function(r){return s.byes[r]===t.teamNo?'BYE':(t.byRound[r]==null?'':_round1_(t.byRound[r]));})};}),rosterError:s.rosterError};
}
function getCompReport_(comp){return reportFromStandings_(getStandings_(comp));}

function outputWorkbookId_(value){
 var v=String(value||'').trim();if(!v)return '';
 var m=v.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);if(m)v=m[1];
 if(!/^[A-Za-z0-9_-]{20,100}$/.test(v))throw new Error('Enter a Google Sheets workbook ID or URL.');return v;
}
function getOutputConfig_(comp){
 var rows=requireSb_(sbGet_('comps','select=output_workbook_id&comp_ref=eq.'+encodeURIComponent(comp))).data;
 if(!rows.length)throw new Error('Competition not found.');var id=rows[0].output_workbook_id||'';
 return {ok:true,workbookId:id,url:id?'https://docs.google.com/spreadsheets/d/'+id+'/edit':'',message:id?'Output: Retro Results. Preview a completed, scan-linked round before sending.':'No output configured. Save the competition workbook ID below. It must contain the Retro Results template and be editable by the Apps Script owner.'};
}
function validateOutputWorkbook_(id){
 var ss=SpreadsheetApp.openById(id),sh=findSheet_(ss,'Retro Results');if(!sh)throw new Error('Workbook needs a Retro Results sheet.');
 ['Line1_Names','Line2_Names','Line3_Names','Line4_Names','Line5_Names','Team_Names'].forEach(function(n){var r=ss.getRangeByName(n);if(!r||r.getSheet().getSheetId()!==sh.getSheetId()||r.getNumColumns()!==1)throw new Error('Retro Results needs the named range '+n+'.');});
 var first=ss.getRangeByName('Line1_Names'),col=first.getColumn(),count=_retroRoundCols_(sh,first.getRow()-1,col+2);
 if(!count)throw new Error('Retro Results needs sequential numeric round headers after Player and Line.');
 ['Line2_Names','Line3_Names','Line4_Names','Line5_Names','Team_Names'].forEach(function(n){if(ss.getRangeByName(n).getColumn()!==col)throw new Error('All output name ranges must share the same column.');});
 var team=ss.getRangeByName('Team_Names');if(_retroRoundCols_(sh,team.getRow()-1,col+2)!==count)throw new Error('Player and team round headers must match.');
 return ss;
}
function saveOutputConfig_(comp,value){
 var id=outputWorkbookId_(value);if(id)validateOutputWorkbook_(id);
 requireSb_(sbUpdate_('comps','comp_ref=eq.'+encodeURIComponent(comp),{output_workbook_id:id||null}));return getOutputConfig_(comp);
}
function getDrawUrl_(comp){return getOutputConfig_(comp);}
function outputRoundPlan_(comp,round){
 round=Number(round);if(!Number.isInteger(round)||round<1)throw new Error('Choose a round.');
 var cfg=getOutputConfig_(comp);if(!cfg.workbookId)throw new Error(cfg.message);
 var ss=validateOutputWorkbook_(cfg.workbookId),sh=findSheet_(ss,'Retro Results'),data=loadCompetitionData_(comp),s=buildCompetitionStandings_(data,getRules_(comp));
 var fixtures=data.fixtures.filter(function(f){return Number(f.round)===round;}),byFixture={};data.matches.forEach(function(m){byFixture[m.fixture_id]=m;});
 if(!fixtures.length)throw new Error('No fixtures for this round.');
 var missing=fixtures.filter(function(f){return !byFixture[f.fixture_id];}).map(function(f){return f.fixture_id;});
 var scans=fixtures.filter(function(f){var m=byFixture[f.fixture_id];return m&&!m.scan_link;}).map(function(f){return f.fixture_id;});
 if(missing.length||scans.length)throw new Error('Round is not ready. Missing results: '+(missing.join(', ')||'none')+'. Missing scanned sheets: '+(scans.join(', ')||'none')+'. Commit/reconcile these scans before sending.');
 var first=ss.getRangeByName('Line1_Names'),start=first.getColumn()+2,header=first.getRow()-1,cols=_retroRoundCols_(sh,header,start);
 if(round>cols)throw new Error('Retro Results has no column for round '+round+'. Extend the sequential round headers before TOTAL, keeping the formulas.');
 var report=reportFromStandings_(s),ri=report.rounds.indexOf(round),writes=[],changes=[];
 function block(n,rows,isTeam){
  var range=ss.getRangeByName(n),names=range.getValues(),oldRound=sh.getRange(range.getRow(),start+round-1,range.getNumRows(),1),old=oldRound.getValues(),formulas=oldRound.getFormulas(),used={};
  if(rows.length>range.getNumRows())throw new Error(n+' has fewer rows than the competition. Extend the named range first.');
  for(var i=0;i<names.length;i++){
   var label=String(names[i][0]||'').trim(),row=label?rows.filter(function(p){return _normName_(isTeam?p.team:p.player)===_normName_(label);}):[];
   if(label&&row.length!==1)throw new Error('Cannot safely map '+n+' row '+(range.getRow()+i)+' ('+label+'). Update its name to one unique current '+(isTeam?'team':'player')+'.');
   var p=row[0]||(!label?rows[i]:null);if(!p)continue;
   var identity=isTeam?p.teamNo:p.playerId;if(used[identity])throw new Error('Duplicate output row: '+label);used[identity]=true;
   var value=p.byRound[ri];if(value==='CHECK'||value==='')throw new Error('Unresolved round '+round+' value for '+(p.player||p.team)+'. Check fixtures and roster before output.');
   if(formulas[i][0])throw new Error('A round cell contains a formula; no output was written.');
   if(!label)writes.push({row:range.getRow()+i,col:range.getColumn(),value:isTeam?p.team:p.player});
   if(old[i][0]!==value){changes.push({cell:oldRound.getCell(i+1,1).getA1Notation(),name:p.player||p.team,before:old[i][0],after:value});writes.push({row:range.getRow()+i,col:start+round-1,value:value});}
  }
 }
 report.lines.forEach(function(l){block('Line'+l.line+'_Names',l.rows,false);});block('Team_Names',report.teams,true);
 return {workbookId:cfg.workbookId,sheetId:sh.getSheetId(),comp:comp,round:round,writes:writes,changes:changes,fixtures:fixtures.length,url:cfg.url};
}
function outputFingerprint_(plan){return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(plan)));}
function previewRoundOutput_(comp,round){
 var p=outputRoundPlan_(comp,round),token=Utilities.getUuid();CacheService.getScriptCache().put('output:'+token,outputFingerprint_(p),600);
 return {ok:true,token:token,comp:comp,round:p.round,url:p.url,fixtures:p.fixtures,changes:p.changes};
}
function sendRoundOutput_(comp,round,token){
 var lock=LockService.getScriptLock();lock.waitLock(30000);
 try{var p=outputRoundPlan_(comp,round),cache=CacheService.getScriptCache(),expected=cache.get('output:'+token);
  if(!expected||expected!==outputFingerprint_(p))throw new Error('Preview expired or results/output changed. Preview again before sending.');
  if(!p.writes.length)return {ok:true,unchanged:true,url:p.url};
  var backup=DriveApp.getFileById(p.workbookId).makeCopy('Results backup '+comp+' R'+p.round+' '+new Date().toISOString());
  if(outputFingerprint_(outputRoundPlan_(comp,round))!==expected)throw new Error('Results changed while preparing the backup. Preview again before sending.');
  var requests=p.writes.map(function(w){return {updateCells:{range:{sheetId:p.sheetId,startRowIndex:w.row-1,endRowIndex:w.row,startColumnIndex:w.col-1,endColumnIndex:w.col},rows:[{values:[{userEnteredValue:typeof w.value==='number'?{numberValue:w.value}:{stringValue:w.value}}]}],fields:'userEnteredValue'}};});
  applyOutputCells_(SpreadsheetApp.openById(p.workbookId).getSheets().filter(function(sh){return sh.getSheetId()===p.sheetId;})[0],requests);
  cache.remove('output:'+token);return {ok:true,changed:p.changes.length,url:p.url,backupUrl:backup.getUrl()};
 }finally{lock.releaseLock();}
}
// Explicit maintenance command for the user-requested historical audit.
// Does not run on result commits or during normal round distribution.
function repairWednesdayOutput(){assertAdmin_();return repairHistoricalOutput_('WPM202607');}
function repairHistoricalOutput_(comp){
 var cfg=getOutputConfig_(comp);if(!cfg.workbookId)throw new Error(cfg.message);
 var ss=validateOutputWorkbook_(cfg.workbookId),sh=findSheet_(ss,'Retro Results'),s=getStandings_(comp),report=reportFromStandings_(s);
 if(s.warnings.length)throw new Error(s.warnings.join('; '));
 var first=ss.getRangeByName('Line1_Names'),start=first.getColumn()+2,cols=_retroRoundCols_(sh,first.getRow()-1,start),requests=[],changes=[];
 function add(row,col,value){requests.push({updateCells:{range:{sheetId:sh.getSheetId(),startRowIndex:row-1,endRowIndex:row,startColumnIndex:col-1,endColumnIndex:col},rows:[{values:[{userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:String(value)}}]}],fields:'userEnteredValue'}});}
 function block(name,rows,team){var nr=ss.getRangeByName(name),names=nr.getValues(),cells=sh.getRange(nr.getRow(),start,nr.getNumRows(),cols),values=cells.getValues(),formulas=cells.getFormulas();
  names.forEach(function(n,i){var hits=rows.filter(function(p){return _normName_(team?p.team:p.player)===_normName_(n[0]);});if(hits.length!==1)throw new Error('Unsafe row mapping '+name+' '+n[0]);
   for(var j=0;j<cols;j++){if(formulas[i][j])throw new Error('Round formula at '+cells.getCell(i+1,j+1).getA1Notation());var index=report.rounds.indexOf(j+1);if(index<0)continue;var value=hits[0].byRound[index];if(value==='CHECK')throw new Error('Ambiguous scheduled match');if(values[i][j]!==value){changes.push({cell:cells.getCell(i+1,j+1).getA1Notation(),before:values[i][j],after:value});add(nr.getRow()+i,start+j,value);}}
  });
 }
 report.lines.forEach(function(l){block('Line'+l.line+'_Names',l.rows,false);});block('Team_Names',report.teams,true);
 if(!changes.length){Logger.log('Retro Results already matches the audited calculation.');return {ok:true,changed:0};}
 var backup=DriveApp.getFileById(cfg.workbookId).makeCopy('Before historical results repair '+comp+' '+new Date().toISOString());
 add(2,1,'AWAY = absent from scheduled match. BYE = no scheduled match. Sub appearances count for the team only.');
 applyOutputCells_(sh,requests);
 var rules=sh.getConditionalFormatRules(),ranges=[sh.getRange(first.getRow(),start,35,cols),sh.getRange(ss.getRangeByName('Team_Names').getRow(),start,7,cols)];
 ['AWAY','BYE'].forEach(function(v){rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(v).setBackground(v==='AWAY'?'#fff2cc':'#ccffff').setRanges(ranges).build());});sh.setConditionalFormatRules(rules);sh.setColumnWidths(start,cols,58);
 SpreadsheetApp.flush();Logger.log(JSON.stringify({ok:true,changed:changes.length,backupUrl:backup.getUrl(),changes:changes}));return {ok:true,changed:changes.length,backupUrl:backup.getUrl()};
}


// One native range write preserves existing formulas and all formatting.
// This works without enabling the separate Advanced Sheets API.
function applyOutputCells_(sheet,requests){
 var cells=requests.map(function(r){var u=r.updateCells;return {row:u.range.startRowIndex+1,col:u.range.startColumnIndex+1,value:u.rows[0].values[0].userEnteredValue};});
 if(!cells.length)return;
 var top=Math.min.apply(null,cells.map(function(c){return c.row;})),bottom=Math.max.apply(null,cells.map(function(c){return c.row;})),left=Math.min.apply(null,cells.map(function(c){return c.col;})),right=Math.max.apply(null,cells.map(function(c){return c.col;}));
 var range=sheet.getRange(top,left,bottom-top+1,right-left+1),values=range.getValues(),formulas=range.getFormulas();
 values.forEach(function(row,i){row.forEach(function(v,j){if(formulas[i][j])values[i][j]=formulas[i][j];else if(typeof v==='string'&&v.charAt(0)==='=')values[i][j]="'"+v;});});
 cells.forEach(function(c){var v=c.value;values[c.row-top][c.col-left]=v.numberValue!=null?v.numberValue:(String(v.stringValue||'').charAt(0)==='='?"'"+v.stringValue:v.stringValue||'');});
 range.setValues(values);SpreadsheetApp.flush();
 var actual=range.getValues();cells.forEach(function(c){var want=c.value.numberValue!=null?c.value.numberValue:c.value.stringValue||'';if(actual[c.row-top][c.col-left]!==want)throw new Error('Output read-back mismatch. Inspect the workbook backup before retrying.');});
}

function testInitMPM(){
  try{var comp='MPM202609';var data=loadCompetitionData_(comp);Logger.log('Fixtures: '+data.fixtures.length);Logger.log('Matches: '+data.matches.length);Logger.log('Roster: '+data.roster.length);Logger.log('Teams: '+data.teams.length);var s=buildCompetitionStandings_(data,getRules_(comp));Logger.log('CurrentRoster: '+s.currentRoster.length);Logger.log('Rounds: '+JSON.stringify(s.rounds));initializeRetroResults_(comp,'1kwrwSooSPOp4Z8Y_A8p3Fc9NVaf8qM3VTKIeiOyfcjQ');Logger.log('OK');}catch(err){Logger.log('ERROR: '+err.message);throw err;}}
function initializeRetroResults_(comp,workbookId){
  if(!comp||!workbookId)throw new Error('Competition and workbook ID required');
  var ss=SpreadsheetApp.openById(workbookId);var sh=findSheet_(ss,'Retro Results');
  if(!sh)throw new Error('Workbook must have a Retro Results sheet');
  sh.clear();var data=loadCompetitionData_(comp);var s=buildCompetitionStandings_(data,getRules_(comp));
  var rounds=s.rounds.sort(function(a,b){return a-b;});var maxRound=Math.max.apply(null,rounds)||0;
  var col=1;
  sh.getRange(1,col).setValue('Player');sh.getRange(1,col+1).setValue('');
  for(var r=0;r<maxRound;r++){sh.getRange(1,col+2+r).setValue(r+1);}
  var lineNames={};for(var l=1;l<=5;l++){lineNames[l]=[];}
  s.currentRoster.forEach(function(p){if(lineNames[p.line])lineNames[p.line].push(p.player);});
  var rowNum=2;
  for(var l=1;l<=5;l++){
    var names=lineNames[l];
    var size=Math.max(1,names.length);
    var startRow=rowNum;
    for(var i=0;i<size;i++){sh.getRange(rowNum+i,col).setValue(names[i]||'');}
    ss.setNamedRange('Line'+l+'_Names',sh.getRange(startRow,col,size,1));
    rowNum+=size;
  }
  var teamNames=[];s.teams.forEach(function(t){teamNames.push(t.team);});
  var tsize=Math.max(1,teamNames.length);
  var startRow=rowNum;
  for(var i=0;i<tsize;i++){sh.getRange(rowNum+i,col).setValue(teamNames[i]||'');}
  ss.setNamedRange('Team_Names',sh.getRange(startRow,col,tsize,1));
  SpreadsheetApp.flush();return {ok:true,message:'Retro Results initialized for '+comp+' with '+maxRound+' rounds'};
}
