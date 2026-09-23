/**************************************************************************
 * SupabaseSync.gs — connectivity test now; backfill/write functions land
 * here as the migration progresses. Lives in the same Apps Script project
 * as AdminApp.gs (comp-admin/), reusing its prop()/propOpt() helpers.
 **************************************************************************/

// Run this once from the Apps Script editor to confirm SUPABASE_URL and
// SUPABASE_SERVICE_KEY are both set correctly and actually reach the project,
// before building anything that depends on them.
function testSupabaseConnection_(){
  var url = prop_('SUPABASE_URL') + '/rest/v1/comps?select=comp_ref';
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'apikey': prop_('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + prop_('SUPABASE_SERVICE_KEY')
    },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode(), body = resp.getContentText();
  Logger.log('HTTP ' + code + ': ' + body);
  // Expect: 200 and '[]' - the comps table exists but has zero rows so far,
  // since nothing has been backfilled into it yet. Anything else (401/403 =
  // bad key, 404 = wrong URL/table name, connection error = wrong URL
  // entirely) means stop here and fix the Script Properties before going
  // any further.
  return {ok: code===200, status: code, body: body};
}

// Second backfill step: players, from MASTER's Contacts tab. Comp-agnostic -
// covers everyone across every comp in one pass. Required before roster/
// fixtures/match_log, which all reference player_id.
//
// Batched (200 rows/request) rather than one payload - defensive against
// PostgREST payload limits given the real row count here isn't yet known
// from this side. Safe to re-run: same merge-duplicates upsert pattern as
// backfillComps, keyed on player_id (the primary key).
function backfillPlayers_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var sh = findSheet_(master, 'Contacts');
  if(!sh) return {ok:false, error:'no Contacts tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'Contacts tab has no data rows'};
  var H = hmap_(v[0]);
  if(H.playerid==null || H.name==null) return {ok:false, error:'Contacts tab missing PlayerID or Name column - check header text'};

  var rows = [], skipped = 0;
  for(var r=1; r<v.length; r++){
    var id = String(v[r][H.playerid]||'').trim();
    var name = String(v[r][H.name]||'').trim();
    if(!id || !name){ skipped++; continue; }   // can't backfill a row with no PlayerID or no Name
    rows.push({
      player_id: id,
      name: name,
      email: H.email!=null ? String(v[r][H.email]||'') : '',
      phone: H.phone!=null ? String(v[r][H.phone]||'') : '',
      grade: H.grade!=null ? String(v[r][H.grade]||'') : ''
    });
  }
  if(!rows.length) return {ok:false, error:'no valid PlayerID+Name rows found', skipped:skipped};

  var BATCH = 200, sent = 0, batchResults = [];
  for(var i=0; i<rows.length; i+=BATCH){
    var batch = rows.slice(i, i+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL') + '/rest/v1/players', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': prop_('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + prop_('SUPABASE_SERVICE_KEY'),
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i+'-'+(i+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'Contacts: ' + rows.length + ' valid rows, ' + skipped + ' skipped (missing PlayerID or Name). Sent ' + sent + '/' + rows.length + ' successfully.';
  Logger.log(msg);
  Logger.log(JSON.stringify(batchResults));
  return {ok: sent===rows.length, totalValid: rows.length, skipped: skipped, sent: sent, batchResults: batchResults};
}

// First backfill step (already run and verified) - comps: 2-3 known rows,
// values you can eyeball. Validates the WRITE path (POST + upsert), which
// testSupabaseConnection() above never exercised. Safe to re-run: uses
// Prefer: resolution=merge-duplicates, upserting on comp_ref (the primary
// key) rather than duplicating rows.
function backfillComps_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var sh = findSheet_(master, 'Comps');
  if(!sh) return {ok:false, error:'no Comps tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'Comps tab has no data rows'};
  var H = hmap_(v[0]);
  if(H['comp ref']==null) return {ok:false, error:'no "Comp Ref" column found - check header text matches exactly'};

  var rows = [];
  for(var r=1; r<v.length; r++){
    var ref = String(v[r][H['comp ref']]||'').trim();
    if(!ref) continue;
    rows.push({
      comp_ref: ref,
      comp_name: String(v[r][H['comp name']]||''),
      active: !!v[r][H['active']],
      points_per_game: parseInt(v[r][H['pointspergame']],10) || 15,
      win_by_two: !!v[r][H['winbytwo']],
      best_of: parseInt(v[r][H['bestof']],10) || 5
    });
  }
  if(!rows.length) return {ok:false, error:'Comps tab has a header row but no valid Comp Ref values under it'};

  var url = prop_('SUPABASE_URL') + '/rest/v1/comps';
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'apikey': prop_('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + prop_('SUPABASE_SERVICE_KEY'),
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode(), body = resp.getContentText();
  Logger.log('Sent ' + rows.length + ' rows. HTTP ' + code + ': ' + body);
  return {ok: code>=200 && code<300, status: code, body: body, rowsSent: rows.length};
}

// Pre-migration hygiene check, not part of the sync pipeline itself: scans
// every cell of MatchLog/GameLog/Fixtures/Roster in MASTER for a literal
// PlayerID string, so a duplicate-contact decision (e.g. which of two IDs
// for the same person to keep) can be made knowing whether the ID being
// dropped is actually referenced anywhere, or safely unused. Read-only -
// writes nothing, changes nothing.
function findPlayerIdUsage_(playerId){
  var ss = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var targets = ['MatchLog','GameLog','Fixtures','Roster'];
  var hits = {};
  targets.forEach(function(name){
    var sh = findSheet_(ss, name);
    if(!sh){ hits[name] = 'tab not found'; return; }
    var v = sh.getDataRange().getValues();
    if(v.length < 2){ hits[name] = []; return; }
    var found = [];
    for(var r=1; r<v.length; r++){
      for(var c=0; c<v[r].length; c++){
        if(String(v[r][c]).trim() === playerId){ found.push(r+1); break; }
      }
    }
    hits[name] = found;
  });
  var lines = Object.keys(hits).map(function(k){
    var h = hits[k];
    if(typeof h === 'string') return k + ': ' + h;
    return k + ': ' + (h.length ? h.length + ' row(s) - sheet row(s) ' + h.join(',') : 'none');
  });
  var msg = 'Usage of ' + playerId + ':\n' + lines.join('\n');
  Logger.log(msg);
  return {ok:true, playerId:playerId, hits:hits, message:msg};
}

// Apps Script's Run button calls whatever's selected with zero arguments -
// these exist purely so findPlayerIdUsage() can actually be run from the
// editor's function dropdown without arguments. Delete once the duplicate
// is resolved; they're throwaway, not part of the ongoing pipeline.
function checkP0067_(){ return findPlayerIdUsage_('P0067'); }
function checkP0033_(){ return findPlayerIdUsage_('P0033'); }

// Third backfill step: teams. Unlike comps/players, there's no dedicated
// source table for this in MASTER - team identity is currently implicit,
// duplicated across every Fixtures row. This derives distinct (comp,
// team_no, team_name) triples from Fixtures directly, since Fixtures is the
// one table already unified across BOTH comps (unlike Roster, still split
// between MASTER and WPM's Draw workbook).
//
// Flags (doesn't silently resolve) any case where the same comp+team_no
// shows two different team names across the season - a rename or a typo,
// worth a human looking at rather than picking one arbitrarily.
//
// IMPORTANT: teams.team_id is a SERIAL surrogate key - the real uniqueness
// is the (comp_ref, team_no) constraint, not team_id. Without explicitly
// telling PostgREST that via on_conflict, its default upsert targets the
// primary key, which would just insert a fresh row every re-run instead of
// updating. This is NOT something mock-based execution testing can catch -
// it's real Postgres/PostgREST behavior, not JS logic. After running this,
// verify idempotency for real: run it twice and confirm the row count in
// `teams` doesn't change between runs, or run
//   SELECT comp_ref, team_no, count(*) FROM teams GROUP BY comp_ref, team_no HAVING count(*) > 1;
// which should return zero rows.
function backfillTeams_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var sh = findSheet_(master, 'Fixtures');
  if(!sh) return {ok:false, error:'no Fixtures tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'Fixtures tab has no data rows'};
  var H = hmap_(v[0]);
  var need = ['comp','team1no','team1','team2no','team2'];
  for(var i=0;i<need.length;i++){ if(H[need[i]]==null) return {ok:false, error:'Fixtures tab missing column: '+need[i]}; }

  var seen = {}, conflicts = [];
  function note(comp, teamNo, teamName){
    comp = String(comp||'').trim(); teamName = String(teamName||'').trim();
    if(!comp || !teamNo) return;
    var key = comp + '|' + teamNo;
    if(!seen[key]){ seen[key] = {comp:comp, teamNo:teamNo, teamName:teamName}; }
    else if(teamName && seen[key].teamName && seen[key].teamName !== teamName){
      conflicts.push(key + ': "' + seen[key].teamName + '" vs "' + teamName + '"');
    }
  }
  for(var r=1; r<v.length; r++){
    note(v[r][H.comp], parseInt(v[r][H.team1no],10), v[r][H.team1]);
    note(v[r][H.comp], parseInt(v[r][H.team2no],10), v[r][H.team2]);
  }

  var rows = Object.keys(seen).map(function(k){ var t=seen[k]; return {comp_ref:t.comp, team_no:t.teamNo, team_name:t.teamName}; });
  if(!rows.length) return {ok:false, error:'no team rows derived from Fixtures', conflicts:conflicts};

  var BATCH=200, sent=0, batchResults=[];
  for(var i2=0;i2<rows.length;i2+=BATCH){
    var batch = rows.slice(i2,i2+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/teams?on_conflict=comp_ref,team_no', {
      method:'post', contentType:'application/json',
      headers:{
        'apikey':prop_('SUPABASE_SERVICE_KEY'),
        'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'),
        'Prefer':'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i2+'-'+(i2+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i2, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'Teams derived: '+rows.length+' distinct (comp, team_no) pairs from Fixtures. '+conflicts.length+' name conflict(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(conflicts.length) Logger.log('CONFLICTS (not auto-resolved - check these manually):\n'+conflicts.join('\n'));
  return {ok: sent===rows.length && !conflicts.length, rowsSent:sent, totalRows:rows.length, conflicts:conflicts, batchResults:batchResults};
}

// Fourth backfill step: roster. The most complex one so far - two things
// the previous three didn't need:
//
// 1. roster.team_id is a foreign key into teams, not the raw team_no - so
//    this has to GET the already-backfilled teams from Supabase first and
//    build a (comp_ref, team_no) -> team_id lookup before it can construct
//    a single row.
// 2. Roster data lives in TWO different places depending on comp: MASTER's
//    own Roster tab (comp-tagged, currently MPM202609 only) and WPM's
//    separate Draw workbook (DRAW_ID, not comp-tagged - hardcoded to
//    'WPM202607' below since that's the only comp DRAW_ID currently points
//    at; if DRAW_ID is ever repointed before this runs, that hardcode goes
//    stale and needs updating here first).
//
// PlayerID resolution is done fresh against Contacts by name (_normName),
// not by trusting any 'PlayerID' column that may already exist in either
// Roster source - Contacts is the single source of truth for identity,
// and a stamped column elsewhere could be stale.
//
// Anything that can't be resolved (no matching teams row, no Contacts
// match) is skipped and reported in `warnings`, never silently dropped.
// Explicit, human-confirmed bare-first-name aliases surfaced by backfillMatchLog/
// GameLog/RallyLog's "no Contacts match" warnings. This is NOT fuzzy-matching -
// every entry here was confirmed by Justin against real knowledge of who
// actually played, since guessing wrong would misattribute a real match result
// to the wrong person. Add entries here only on explicit confirmation, never
// speculatively. Leigh Chalker and Paige Fuller must exist in Contacts before
// this resolves them - see addAliasContacts() below.
var KNOWN_NAME_ALIASES = {
  'kingsley': 'Kingsley Hunt',
  'kevin': 'Kevin Joselyn',
  'josh': 'Josh Casamento',
  'leigh': 'Leigh Chalker',
  'ben': 'Ben Fink',
  'paige': 'Paige Fuller',
  'shannon': 'Shannon Bossard',
  'mark': 'Mark Brycki'
};

// One-off: mint Leigh Chalker and Paige Fuller into Contacts via the existing
// syncContacts (same dedupe-by-name, same PlayerID numbering) - run once,
// before re-running backfillMatchLog/GameLog/RallyLog, or the alias table
// above has nothing to resolve 'leigh'/'paige' TO yet.
function addAliasContacts_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var result = syncContacts_(master, [
    { player: 'Leigh Chalker', phone: '', email: '' },
    { player: 'Paige Fuller', phone: '', email: '' }
  ]);
  Logger.log('addAliasContacts: '+JSON.stringify(result));
  return result;
}

function backfillRoster_(){
  var teamsResp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/teams?select=team_id,comp_ref,team_no', {
    method:'get',
    headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY') },
    muteHttpExceptions:true
  });
  if(teamsResp.getResponseCode()!==200) return {ok:false, error:'could not fetch teams from Supabase: HTTP '+teamsResp.getResponseCode()+' '+teamsResp.getContentText()};
  var teamIdLookup = {};
  JSON.parse(teamsResp.getContentText()).forEach(function(t){ teamIdLookup[t.comp_ref+'|'+t.team_no] = t.team_id; });

  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var contactsSh = findSheet_(master, 'Contacts');
  var nameToId = {};
  if(contactsSh){
    var cv = contactsSh.getDataRange().getValues(), CH = hmap_(cv[0]);
    if(CH.name!=null && CH.playerid!=null){
      for(var cr=1; cr<cv.length; cr++){
        var nm = String(cv[cr][CH.name]||'').trim(), id = String(cv[cr][CH.playerid]||'').trim();
        if(nm && id) nameToId[_normName_(nm)] = id;
      }
    }
  }

  var rows = [], warnings = [];
  function addRosterRow(sourceLabel, comp, teamNo, line, player, captain){
    if(!player) return;
    var key = comp+'|'+teamNo;
    var teamId = teamIdLookup[key];
    if(teamId==null){ warnings.push(sourceLabel+': no teams row for '+key+' (player "'+player+'") - skipped'); return; }
    var pid = nameToId[_normName_(player)];
    if(!pid){ warnings.push(sourceLabel+': no Contacts match for "'+player+'" ('+key+') - skipped'); return; }
    rows.push({ comp_ref: comp, team_id: teamId, line: line, player_id: pid, captain: !!captain });
  }

  // Source A: MASTER's own Roster tab (comp-tagged)
  var masterRoster = findSheet_(master, 'Roster');
  if(masterRoster && masterRoster.getLastRow()>1){
    var mv = masterRoster.getDataRange().getValues(), MH = hmap_(mv[0]);
    if(MH.comp!=null && MH.player!=null){
      for(var mr=1; mr<mv.length; mr++){
        addRosterRow('MASTER Roster', String(mv[mr][MH.comp]||'').trim(),
          parseInt(mv[mr][MH.teamno],10)||0, parseInt(mv[mr][MH.line],10)||0,
          String(mv[mr][MH.player]||'').trim(), !!mv[mr][MH.captain]);
      }
    }
  }

  // Source B: WPM's separate Draw workbook Roster tab - not comp-tagged,
  // hardcoded to WPM202607 (see comment above the function).
  try{
    var drawSS = SpreadsheetApp.openById(prop_('DRAW_ID'));
    var drawRoster = findSheet_(drawSS, 'Roster');
    if(drawRoster && drawRoster.getLastRow()>1){
      var dv = drawRoster.getDataRange().getValues(), DH = hmap_(dv[0]);
      for(var dr=1; dr<dv.length; dr++){
        var pn = String(dv[dr][DH.player]||'').trim();
        if(!pn) continue;
        addRosterRow('WPM Draw workbook Roster', 'WPM202607',
          parseInt(dv[dr][DH.teamno],10)||0, parseInt(dv[dr][DH.line],10)||0, pn, false);
      }
    }
  }catch(e){ warnings.push('Could not read WPM Draw workbook Roster: '+e.message); }

  if(!rows.length) return {ok:false, error:'no roster rows resolved', warnings:warnings};

  var BATCH=200, sent=0, batchResults=[];
  for(var i=0;i<rows.length;i+=BATCH){
    var batch = rows.slice(i,i+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/roster?on_conflict=comp_ref,team_id,line', {
      method:'post', contentType:'application/json',
      headers:{
        'apikey':prop_('SUPABASE_SERVICE_KEY'),
        'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'),
        'Prefer':'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i+'-'+(i+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }

  var msg = 'Roster: '+rows.length+' rows resolved (MASTER + WPM Draw workbook), '+warnings.length+' warning(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(warnings.length) Logger.log('WARNINGS:\n'+warnings.join('\n'));
  return {ok: sent===rows.length && !warnings.length, rowsSent:sent, totalRows:rows.length, warnings:warnings, batchResults:batchResults};
}

// Fifth backfill step: fixtures. Needs BOTH FK lookups at once - team_id
// (same GET-teams pattern as roster) and player_id (fresh Contacts lookup,
// same as roster). Only one source this time - MASTER's own Fixtures tab,
// already confirmed unified across both comps when deriving `teams`.
//
// Differs from roster in one important way: a blank Player1/Player2 is a
// NORMAL state (a future round with no assigned player yet) - inserted as
// NULL, no warning. An unresolvable TEAM (team_no with no matching teams
// row - shouldn't happen since teams was derived FROM these fixtures, but
// checked defensively) skips the whole row, since a fixture with no
// resolvable team on either side isn't meaningful. An unresolvable NAMED
// player doesn't sink the row - the team info is still valid - so it's
// kept with that side's player_id left NULL and a warning raised.
//
// 'Played' in Sheets holds a date/timestamp (confirmed via markPlayed()),
// not a boolean - converted here via truthiness, matching the convention
// already used elsewhere (applyRosterToFutureFixtures, upsertMpmFixtures).
//
// fixture_id is already the natural primary key (matches Sheets' own Id
// format exactly) - unlike teams/roster, no explicit on_conflict needed;
// PostgREST's default upsert-on-primary-key is correct here.
function backfillFixtures_(){
  var teamsResp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/teams?select=team_id,comp_ref,team_no', {
    method:'get',
    headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY') },
    muteHttpExceptions:true
  });
  if(teamsResp.getResponseCode()!==200) return {ok:false, error:'could not fetch teams from Supabase: HTTP '+teamsResp.getResponseCode()+' '+teamsResp.getContentText()};
  var teamIdLookup = {};
  JSON.parse(teamsResp.getContentText()).forEach(function(t){ teamIdLookup[t.comp_ref+'|'+t.team_no] = t.team_id; });

  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var contactsSh = findSheet_(master, 'Contacts');
  var nameToId = {};
  if(contactsSh){
    var cv = contactsSh.getDataRange().getValues(), CH = hmap_(cv[0]);
    if(CH.name!=null && CH.playerid!=null){
      for(var cr=1; cr<cv.length; cr++){
        var nm = String(cv[cr][CH.name]||'').trim(), id = String(cv[cr][CH.playerid]||'').trim();
        if(nm && id) nameToId[_normName_(nm)] = id;
      }
    }
  }

  var sh = findSheet_(master, 'Fixtures');
  if(!sh) return {ok:false, error:'no Fixtures tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'Fixtures tab has no data rows'};
  var H = hmap_(v[0]);
  var need = ['id','comp','round','line','team1no','team1','player1','team2no','team2','player2'];
  for(var i=0;i<need.length;i++){ if(H[need[i]]==null) return {ok:false, error:'Fixtures tab missing column: '+need[i]}; }

  function resolvePlayer(name, warnLabel, warnings){
    name = String(name||'').trim();
    if(!name) return null;   // blank = genuinely unassigned, not a problem
    var pid = nameToId[_normName_(name)];
    if(!pid) warnings.push(warnLabel+': no Contacts match for "'+name+'" - left null');
    return pid || null;
  }

  var rows = [], warnings = [], skippedNoTeam = 0;
  for(var r=1; r<v.length; r++){
    var comp = String(v[r][H.comp]||'').trim();
    var fid = String(v[r][H.id]||'').trim();
    if(!comp || !fid) continue;
    var t1no = parseInt(v[r][H.team1no],10), t2no = parseInt(v[r][H.team2no],10);
    var team1_id = teamIdLookup[comp+'|'+t1no], team2_id = teamIdLookup[comp+'|'+t2no];
    if(team1_id==null || team2_id==null){
      warnings.push(fid+': team not found in teams table (comp '+comp+', team1no '+t1no+', team2no '+t2no+') - row skipped entirely');
      skippedNoTeam++;
      continue;
    }
    var schedRaw = H.scheduled!=null ? v[r][H.scheduled] : null;
    var scheduled = (schedRaw instanceof Date) ? schedRaw.toISOString() : (schedRaw ? String(schedRaw) : null);
    rows.push({
      fixture_id: fid,
      comp_ref: comp,
      round: String(v[r][H.round]||''),
      line: parseInt(v[r][H.line],10) || null,
      team1_id: team1_id,
      team2_id: team2_id,
      player1_id: resolvePlayer(v[r][H.player1], fid+' player1', warnings),
      player2_id: resolvePlayer(v[r][H.player2], fid+' player2', warnings),
      scheduled: scheduled,
      played: H.played!=null ? !!v[r][H.played] : false
    });
  }
  if(!rows.length) return {ok:false, error:'no fixture rows resolved', warnings:warnings};

  var BATCH=200, sent=0, batchResults=[];
  for(var i2=0;i2<rows.length;i2+=BATCH){
    var batch = rows.slice(i2,i2+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/fixtures', {
      method:'post', contentType:'application/json',
      headers:{
        'apikey':prop_('SUPABASE_SERVICE_KEY'),
        'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'),
        'Prefer':'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(batch),
      muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i2+'-'+(i2+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i2, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'Fixtures: '+rows.length+' rows resolved, '+skippedNoTeam+' skipped entirely (no team match), '+warnings.length+' total warning(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(warnings.length) Logger.log('WARNINGS:\n'+warnings.join('\n'));
  return {ok: sent===rows.length, rowsSent:sent, totalRows:rows.length, skippedNoTeam:skippedNoTeam, warnings:warnings, batchResults:batchResults};
}

// Sixth backfill step: match_log - the actual scored history. Two HARD
// constraints checked and filtered BEFORE batching, not after: fixture_id
// must already exist in the backfilled fixtures table, comp_ref must exist
// in comps - both NOT NULL foreign keys, so a single row failing either
// would silently roll back the entire batch it's in (see note above the
// backfill functions in this file). player1_id/player2_id/winner_id
// resolved fresh from Contacts by name, same reasoning as every prior
// backfill. match_id is already the natural primary key - no on_conflict
// parameter needed, unlike teams/roster/game_log/rally_log.
function backfillMatchLog_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var contactsSh = findSheet_(master, 'Contacts');
  var nameToId = {};
  if(contactsSh){
    var cv = contactsSh.getDataRange().getValues(), CH = hmap_(cv[0]);
    if(CH.name!=null && CH.playerid!=null){
      for(var cr=1; cr<cv.length; cr++){
        var nm = String(cv[cr][CH.name]||'').trim(), id = String(cv[cr][CH.playerid]||'').trim();
        if(nm && id) nameToId[_normName_(nm)] = id;
      }
    }
  }

  function fetchIdSet(table, col){
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/'+table+'?select='+col, {
      method:'get',
      headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY') },
      muteHttpExceptions:true
    });
    if(resp.getResponseCode()!==200) throw new Error('could not fetch '+table+': HTTP '+resp.getResponseCode()+' '+resp.getContentText());
    var set = {};
    JSON.parse(resp.getContentText()).forEach(function(row){ set[row[col]] = true; });
    return set;
  }
  var validFixtureIds, validCompRefs;
  try{
    validFixtureIds = fetchIdSet('fixtures', 'fixture_id');
    validCompRefs = fetchIdSet('comps', 'comp_ref');
  }catch(e){ return {ok:false, error:String(e)}; }

  var sh = findSheet_(master, 'MatchLog');
  if(!sh) return {ok:false, error:'no MatchLog tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'MatchLog tab has no data rows'};
  var H = hmap_(v[0]);
  var need = ['matchid','timestamp','date','comp','fixtureid','player1','player2','gamesp1','gamesp2'];
  for(var i=0;i<need.length;i++){ if(H[need[i]]==null) return {ok:false, error:'MatchLog tab missing column: '+need[i]}; }

  function toIso(val){ return (val instanceof Date) ? val.toISOString() : (val ? String(val) : null); }
  function resolveName(name, warnLabel, warnings){
    name = String(name||'').trim();
    if(!name) return null;
    var norm = _normName_(name);
    var alias = KNOWN_NAME_ALIASES[norm];
    var pid = nameToId[alias ? _normName_(alias) : norm];
    if(!pid) warnings.push(warnLabel+': no Contacts match for "'+name+'" - left null');
    return pid || null;
  }

  var rows = [], warnings = [], skipped = 0;
  for(var r=1; r<v.length; r++){
    var matchId = String(v[r][H.matchid]||'').trim();
    if(!matchId){
      // Distinguish a genuinely blank spacer row (normal, silent) from a
      // real row that's missing its MatchId specifically (a real problem -
      // silently continuing here previously made such rows vanish with
      // zero trace anywhere).
      var hasContent = [H.player1,H.player2,H.comp,H.fixtureid].some(function(ci){ return ci!=null && String(v[r][ci]||'').trim()!==''; });
      if(hasContent){ warnings.push('sheet row '+(r+1)+': has content but no MatchId - row skipped entirely'); skipped++; }
      continue;
    }
    var fixtureId = String(v[r][H.fixtureid]||'').trim();
    var comp = String(v[r][H.comp]||'').trim();
    // Fallback: some rows (seen in practice - paper-scorecard "scan-" entries)
    // have a blank Comp cell despite the comp being recoverable from the
    // fixtureId itself, e.g. "scan-WPM202607-R3-L1-M3". Only used when the
    // Comp cell is genuinely blank - never overrides an actual value.
    if(!comp && fixtureId){
      var m = fixtureId.match(/^(?:scan-)?(.+)-R\d+-L\d+-M\d+$/);
      if(m) comp = m[1];
    }
    if(!fixtureId || !validFixtureIds[fixtureId]){
      warnings.push(matchId+': fixtureId "'+fixtureId+'" not found in backfilled fixtures - row skipped entirely'); skipped++; continue;
    }
    if(!comp || !validCompRefs[comp]){
      warnings.push(matchId+': comp "'+comp+'" not found in backfilled comps - row skipped entirely'); skipped++; continue;
    }
    var committedTs = toIso(v[r][H.timestamp]) || toIso(v[r][H.date]) || new Date().toISOString();
    rows.push({
      match_id: matchId, fixture_id: fixtureId, comp_ref: comp,
      match_date: toIso(v[r][H.date]), committed_ts: committedTs,
      player1_id: resolveName(v[r][H.player1], matchId+' player1', warnings),
      player2_id: resolveName(v[r][H.player2], matchId+' player2', warnings),
      sub1: !!v[r][H.sub1], sub2: !!v[r][H.sub2],
      games_p1: parseInt(v[r][H.gamesp1],10) || 0,
      games_p2: parseInt(v[r][H.gamesp2],10) || 0,
      winner_id: H.winner!=null ? resolveName(v[r][H.winner], matchId+' winner', warnings) : null,
      score_line: H.scoreline!=null ? String(v[r][H.scoreline]||'') : '',
      duration_sec: H.durationsec!=null ? (parseInt(v[r][H.durationsec],10)||null) : null,
      scan_link: H.scanlink!=null ? String(v[r][H.scanlink]||'') : '',
      source: H.source!=null ? String(v[r][H.source]||'') : '',
      raw_rally_history: H.rallywinners!=null ? String(v[r][H.rallywinners]||'') : ''
    });
  }
  if(!rows.length) return {ok:false, error:'no match_log rows resolved', warnings:warnings, skipped:skipped};

  var BATCH=200, sent=0, batchResults=[];
  for(var i2=0;i2<rows.length;i2+=BATCH){
    var batch = rows.slice(i2,i2+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/match_log', {
      method:'post', contentType:'application/json',
      headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'), 'Prefer':'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(batch), muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i2+'-'+(i2+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i2, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'MatchLog: '+rows.length+' rows resolved, '+skipped+' skipped entirely (bad fixture/comp), '+warnings.length+' total warning(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(warnings.length) Logger.log('WARNINGS:\n'+warnings.join('\n'));
  return {ok: sent===rows.length, rowsSent:sent, totalRows:rows.length, skipped:skipped, warnings:warnings, batchResults:batchResults};
}

// Seventh backfill step: game_log. Same hard-constraint discipline: match_id
// must already exist in the backfilled match_log table, checked via a fresh
// GET rather than assumed from run order. game_winner_id resolved fresh
// from Contacts; scorer/ref stay plain text, matching how the original
// write path treats them (never resolved to an identity there either).
// UNIQUE(match_id, game_no) is the real key, not the surrogate game_pk -
// needs the same explicit on_conflict as teams/roster.
function backfillGameLog_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var contactsSh = findSheet_(master, 'Contacts');
  var nameToId = {};
  if(contactsSh){
    var cv = contactsSh.getDataRange().getValues(), CH = hmap_(cv[0]);
    if(CH.name!=null && CH.playerid!=null){
      for(var cr=1; cr<cv.length; cr++){
        var nm = String(cv[cr][CH.name]||'').trim(), id = String(cv[cr][CH.playerid]||'').trim();
        if(nm && id) nameToId[_normName_(nm)] = id;
      }
    }
  }

  var mlResp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/match_log?select=match_id', {
    method:'get',
    headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY') },
    muteHttpExceptions:true
  });
  if(mlResp.getResponseCode()!==200) return {ok:false, error:'could not fetch match_log ids: HTTP '+mlResp.getResponseCode()+' '+mlResp.getContentText()};
  var validMatchIds = {};
  JSON.parse(mlResp.getContentText()).forEach(function(m){ validMatchIds[m.match_id] = true; });

  var sh = findSheet_(master, 'GameLog');
  if(!sh) return {ok:false, error:'no GameLog tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'GameLog tab has no data rows'};
  var H = hmap_(v[0]);
  var need = ['matchid','gameno','pointsp1','pointsp2'];
  for(var i=0;i<need.length;i++){ if(H[need[i]]==null) return {ok:false, error:'GameLog tab missing column: '+need[i]}; }

  function toIso(val){ return (val instanceof Date) ? val.toISOString() : (val ? String(val) : null); }
  function resolveName(name, warnLabel, warnings){
    name = String(name||'').trim();
    if(!name) return null;
    var norm = _normName_(name);
    var alias = KNOWN_NAME_ALIASES[norm];
    var pid = nameToId[alias ? _normName_(alias) : norm];
    if(!pid) warnings.push(warnLabel+': no Contacts match for "'+name+'" - left null');
    return pid || null;
  }

  var rows = [], warnings = [], skipped = 0;
  for(var r=1; r<v.length; r++){
    var matchId = String(v[r][H.matchid]||'').trim();
    var gameNoRaw = v[r][H.gameno];
    var gameNo = parseInt(gameNoRaw,10);
    if(!matchId){
      var hasContent = [H.player1,H.player2,H.pointsp1,H.pointsp2].some(function(ci){ return ci!=null && String(v[r][ci]||'').trim()!==''; });
      if(hasContent){ warnings.push('sheet row '+(r+1)+': has content but no MatchId - row skipped entirely'); skipped++; }
      continue;
    }
    if(!gameNo){
      warnings.push(matchId+': GameNo did not parse to a valid number (raw value: '+JSON.stringify(gameNoRaw)+') - row skipped entirely');
      skipped++; continue;
    }
    if(!validMatchIds[matchId]){
      warnings.push(matchId+' game '+gameNo+': matchId not found in backfilled match_log - row skipped entirely');
      skipped++; continue;
    }
    rows.push({
      match_id: matchId, game_no: gameNo,
      points_p1: parseInt(v[r][H.pointsp1],10) || 0,
      points_p2: parseInt(v[r][H.pointsp2],10) || 0,
      game_winner_id: H.gamewinner!=null ? resolveName(v[r][H.gamewinner], matchId+' game '+gameNo+' winner', warnings) : null,
      time_start: H.timestart!=null ? toIso(v[r][H.timestart]) : null,
      time_end: H.timeend!=null ? toIso(v[r][H.timeend]) : null,
      duration: H.duration!=null ? (parseInt(v[r][H.duration],10)||null) : null,
      break_time: H.breaktime!=null ? (parseInt(v[r][H.breaktime],10)||null) : null,
      scorer: H.scorer!=null ? String(v[r][H.scorer]||'') : '',
      ref: H.ref!=null ? String(v[r][H.ref]||'') : '',
      committed_datetime: H.committeddatetime!=null ? toIso(v[r][H.committeddatetime]) : null,
      scan_link: H.scanlink!=null ? String(v[r][H.scanlink]||'') : ''
    });
  }
  if(!rows.length) return {ok:false, error:'no game_log rows resolved', warnings:warnings, skipped:skipped};

  var BATCH=200, sent=0, batchResults=[];
  for(var i2=0;i2<rows.length;i2+=BATCH){
    var batch = rows.slice(i2,i2+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/game_log?on_conflict=match_id,game_no', {
      method:'post', contentType:'application/json',
      headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'), 'Prefer':'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(batch), muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i2+'-'+(i2+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i2, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'GameLog: '+rows.length+' rows resolved, '+skipped+' skipped entirely (bad matchId), '+warnings.length+' total warning(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(warnings.length) Logger.log('WARNINGS:\n'+warnings.join('\n'));
  return {ok: sent===rows.length, rowsSent:sent, totalRows:rows.length, skipped:skipped, warnings:warnings, batchResults:batchResults};
}

// Eighth and final backfill step: rally_log - point-by-point detail. Same
// hard-constraint pattern again: (match_id, game_no) must already exist in
// the backfilled game_log table. server/rally_winner resolved fresh from
// Contacts by name - writeRallyLog() stores names directly (confirmed by
// reading the actual write function), not the p1/p2 side-indicator the
// original schema draft wrongly assumed. Header names confirmed from
// RALLYLOG_HEAD: columns are 'Game'/'Rally', not 'GameNo'/'RallyNo'.
function backfillRallyLog_(){
  var master = SpreadsheetApp.openById(prop_('MASTER_ID'));
  var contactsSh = findSheet_(master, 'Contacts');
  var nameToId = {};
  if(contactsSh){
    var cv = contactsSh.getDataRange().getValues(), CH = hmap_(cv[0]);
    if(CH.name!=null && CH.playerid!=null){
      for(var cr=1; cr<cv.length; cr++){
        var nm = String(cv[cr][CH.name]||'').trim(), id = String(cv[cr][CH.playerid]||'').trim();
        if(nm && id) nameToId[_normName_(nm)] = id;
      }
    }
  }

  var glResp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/game_log?select=match_id,game_no', {
    method:'get',
    headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY') },
    muteHttpExceptions:true
  });
  if(glResp.getResponseCode()!==200) return {ok:false, error:'could not fetch game_log keys: HTTP '+glResp.getResponseCode()+' '+glResp.getContentText()};
  var validGameKeys = {};
  JSON.parse(glResp.getContentText()).forEach(function(g_){ validGameKeys[g_.match_id+'|'+g_.game_no] = true; });

  var sh = findSheet_(master, 'RallyLog');
  if(!sh) return {ok:false, error:'no RallyLog tab in MASTER'};
  var v = sh.getDataRange().getValues();
  if(v.length < 2) return {ok:false, error:'RallyLog tab has no data rows'};
  var H = hmap_(v[0]);
  var need = ['matchid','game','rally','p1score','p2score'];
  for(var i=0;i<need.length;i++){ if(H[need[i]]==null) return {ok:false, error:'RallyLog tab missing column: '+need[i]}; }

  function toIso(val){ return (val instanceof Date) ? val.toISOString() : (val ? String(val) : null); }
  function resolveName(name, warnLabel, warnings){
    name = String(name||'').trim();
    if(!name) return null;
    var norm = _normName_(name);
    var alias = KNOWN_NAME_ALIASES[norm];
    var pid = nameToId[alias ? _normName_(alias) : norm];
    if(!pid) warnings.push(warnLabel+': no Contacts match for "'+name+'" - left null');
    return pid || null;
  }

  var rows = [], warnings = [], skipped = 0;
  for(var r=1; r<v.length; r++){
    var matchId = String(v[r][H.matchid]||'').trim();
    var gameNoRaw = v[r][H.game], rallyNoRaw = v[r][H.rally];
    var gameNo = parseInt(gameNoRaw,10);
    var rallyNo = parseInt(rallyNoRaw,10);
    if(!matchId){
      var hasContent = [H.server,H.rallywinner,H.p1score,H.p2score].some(function(ci){ return ci!=null && String(v[r][ci]||'').trim()!==''; });
      if(hasContent){ warnings.push('sheet row '+(r+1)+': has content but no MatchId - row skipped entirely'); skipped++; }
      continue;
    }
    if(!gameNo || !rallyNo){
      warnings.push(matchId+': Game/Rally did not parse to valid numbers (raw Game: '+JSON.stringify(gameNoRaw)+', raw Rally: '+JSON.stringify(rallyNoRaw)+') - row skipped entirely');
      skipped++; continue;
    }
    var key = matchId+'|'+gameNo;
    if(!validGameKeys[key]){
      warnings.push(matchId+' game '+gameNo+' rally '+rallyNo+': (match_id, game_no) not found in backfilled game_log - row skipped entirely');
      skipped++; continue;
    }
    rows.push({
      match_id: matchId,
      fixture_id: H.fixtureid!=null ? String(v[r][H.fixtureid]||'') : null,
      rally_date: H.date!=null ? toIso(v[r][H.date]) : null,
      game_no: gameNo, rally_no: rallyNo,
      server_player_id: H.server!=null ? resolveName(v[r][H.server], matchId+' g'+gameNo+'r'+rallyNo+' server', warnings) : null,
      box: H.box!=null ? String(v[r][H.box]||'') : null,
      p1_score: parseInt(v[r][H.p1score],10) || 0,
      p2_score: parseInt(v[r][H.p2score],10) || 0,
      rally_winner_id: H.rallywinner!=null ? resolveName(v[r][H.rallywinner], matchId+' g'+gameNo+'r'+rallyNo+' winner', warnings) : null
    });
  }
  if(!rows.length) return {ok:false, error:'no rally_log rows resolved', warnings:warnings, skipped:skipped};

  var BATCH=200, sent=0, batchResults=[];
  for(var i2=0;i2<rows.length;i2+=BATCH){
    var batch = rows.slice(i2,i2+BATCH);
    var resp = UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/rally_log?on_conflict=match_id,game_no,rally_no', {
      method:'post', contentType:'application/json',
      headers:{ 'apikey':prop_('SUPABASE_SERVICE_KEY'), 'Authorization':'Bearer '+prop_('SUPABASE_SERVICE_KEY'), 'Prefer':'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(batch), muteHttpExceptions:true
    });
    var code = resp.getResponseCode();
    if(code<200 || code>=300) Logger.log('BATCH FAILURE (rows '+i2+'-'+(i2+batch.length-1)+'): HTTP '+code+' - '+resp.getContentText());
    batchResults.push({batchStart:i2, count:batch.length, status:code, body: code>=300?resp.getContentText():'(ok)'});
    if(code>=200 && code<300) sent += batch.length;
  }
  var msg = 'RallyLog: '+rows.length+' rows resolved, '+skipped+' skipped entirely (bad match/game), '+warnings.length+' total warning(s). Sent '+sent+'/'+rows.length+'.';
  Logger.log(msg);
  if(warnings.length) Logger.log('WARNINGS:\n'+warnings.join('\n'));
  return {ok: sent===rows.length, rowsSent:sent, totalRows:rows.length, skipped:skipped, warnings:warnings, batchResults:batchResults};
}
