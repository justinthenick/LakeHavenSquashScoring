/**************************************************************************
 * SupabaseClient.gs — shared REST helper for the LIVE cutover (Code.gs's
 * Scorer PWA backend and AdminApp.gs's Comp Admin backend). This needs to
 * be duplicated into BOTH clasp-linked projects (scorer-backend/ and
 * comp-admin/) since they're separate Apps Script deployments and can't
 * share a file directly without a published library.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY as Script Properties in
 * BOTH projects - same values as already set up for SupabaseSync.gs.
 *
 * Every function surfaces the real Postgres/PostgREST error immediately on
 * failure (via the returned {ok:false, error:...} shape) rather than
 * hiding it in a response nobody inspects - this is the exact lesson from
 * the migration's batch-failure incident, and it matters more here, not
 * less, since these functions run live on real match nights.
 **************************************************************************/

function sbHeaders_(extra){
  var h = {
    'apikey': prop_('SUPABASE_SERVICE_KEY'),
    'Authorization': 'Bearer ' + prop_('SUPABASE_SERVICE_KEY')
  };
  for(var k in (extra||{})) h[k] = extra[k];
  return h;
}

// GET rows. query is the raw PostgREST query string, e.g.
// "select=*&comp_ref=eq.MPM202609&order=round.asc"
function sbGet_(table,query){
 var keys={comps:'comp_ref',players:'player_id',teams:'team_id',roster:'roster_id',roster_substitutes:'player_id',fixtures:'fixture_id',match_log:'match_id',game_log:'game_pk',rally_log:'rally_pk'};
 if(!keys[table])throw new Error('Unsupported table');
 query=query||'select=*';if(!/(^|&)order=/.test(query))query+='&order='+keys[table]+'.asc';
 var rows=[],offset=0,pageSize=500;
 while(true){
  var resp=UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/'+table+'?'+query,{method:'get',headers:sbHeaders_({'Range':offset+'-'+(offset+pageSize-1),'Prefer':'count=exact'}),muteHttpExceptions:true});
  var status=resp.getResponseCode();if(status<200||status>=300)return sbFailure_(resp);
  var page=JSON.parse(resp.getContentText());if(!Array.isArray(page))throw new Error('Invalid database response');
  rows=rows.concat(page);offset+=page.length;
  var headers=resp.getAllHeaders(),range=headers['Content-Range']||headers['content-range']||'',total=Number(String(range).split('/')[1]);
  if(!page.length||(Number.isFinite(total)&&offset>=total)||(!range&&page.length<pageSize))break;
  if(offset>100000)throw new Error('Result exceeds supported size; narrow the query');
 }
 return {ok:true,data:rows};
}

// Insert/upsert rows. onConflict is optional - required whenever the
// table's real uniqueness is NOT its literal primary key (e.g. roster,
// teams, game_log, rally_log all needed this in the backfill; fixtures,
// match_log, comps, players did not, since their PK IS the natural key).
// rows can be a single object or an array.
function sbUpsert_(table, rows, onConflict){
  var arr = Array.isArray(rows) ? rows : [rows];
  var url = prop_('SUPABASE_URL') + '/rest/v1/' + table + (onConflict ? '?on_conflict='+onConflict : '');
  var resp = UrlFetchApp.fetch(url, {
    method:'post', contentType:'application/json',
    headers: sbHeaders_({ 'Prefer':'resolution=merge-duplicates,return=minimal' }),
    payload: JSON.stringify(arr), muteHttpExceptions:true
  });
  var code = resp.getResponseCode();
  if(code < 200 || code >= 300){
    var msg = 'Supabase upsert into '+table+' failed ('+arr.length+' row(s)): HTTP '+code+' - '+resp.getContentText();
    Logger.log(msg);
    return { ok:false, error: msg };
  }
  return { ok:true, count: arr.length };
}

// Update existing rows matching a filter. filter is a PostgREST filter
// string WITHOUT the leading '?', e.g. "fixture_id=eq.MPM202609-R1-L1-M1".
// Needed for things like markPlayed() - flipping a single field on an
// existing row, not inserting a new one.
function sbUpdate_(table, filter, updates){
  var url = prop_('SUPABASE_URL') + '/rest/v1/' + table + '?' + filter;
  var resp = UrlFetchApp.fetch(url, {
    method:'patch', contentType:'application/json',
    headers: sbHeaders_({ 'Prefer':'return=minimal' }),
    payload: JSON.stringify(updates), muteHttpExceptions:true
  });
  var code = resp.getResponseCode();
  if(code < 200 || code >= 300){
    var msg = 'Supabase update on '+table+' ('+filter+') failed: HTTP '+code+' - '+resp.getContentText();
    Logger.log(msg);
    return { ok:false, error: msg };
  }
  return { ok:true };
}

function sbDelete_(table, filter){
  var url = prop_('SUPABASE_URL') + '/rest/v1/' + table + '?' + filter;
  var resp = UrlFetchApp.fetch(url, { method:'delete', headers: sbHeaders_({'Prefer':'return=minimal'}), muteHttpExceptions:true });
  var code = resp.getResponseCode();
  if(code < 200 || code >= 300){
    var msg = 'Supabase delete on '+table+' ('+filter+') failed: HTTP '+code+' - '+resp.getContentText();
    Logger.log(msg);
    return { ok:false, error: msg };
  }
  return { ok:true };
}

function sbFailure_(resp){
 var status=resp.getResponseCode(),body;try{body=JSON.parse(resp.getContentText());}catch(e){body={message:'Database request failed ('+status+')'};}
 return {ok:false,error:body.message||'Database request failed',code:body.code||String(status),retryable:status>=500||status===429||status===408};
}
function sbRpc_(name,args){
 var resp=UrlFetchApp.fetch(prop_('SUPABASE_URL')+'/rest/v1/rpc/'+name,{method:'post',contentType:'application/json',headers:sbHeaders_(),payload:JSON.stringify(args),muteHttpExceptions:true});
 if(resp.getResponseCode()<200||resp.getResponseCode()>=300)return sbFailure_(resp);
 return JSON.parse(resp.getContentText());
}
function requireSb_(r){if(!r||!r.ok)throw new Error((r&&r.error)||'Database operation failed');return r;}
