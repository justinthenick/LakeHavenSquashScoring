// Admin "Merge players": find likely duplicates, preview what would move, merge.
// Public (browser-callable) wrappers live in Security.gs and are admin-guarded.
// The database does the heavy lifting in cc_player_merge / cc_player_merge_preview
// (database/player_merge.sql) so every merge is a single transaction.

function pmNorm_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function pmLev_(a,b,max){
 if(a===b)return 0;if(Math.abs(a.length-b.length)>max)return max+1;
 var prev=[],cur=[],i,j;for(j=0;j<=b.length;j++)prev[j]=j;
 for(i=1;i<=a.length;i++){cur[0]=i;var rowMin=cur[0];
  for(j=1;j<=b.length;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a.charAt(i-1)===b.charAt(j-1)?0:1));if(cur[j]<rowMin)rowMin=cur[j];}
  if(rowMin>max)return max+1;var t=prev;prev=cur;cur=t;}
 return prev[b.length];
}
// Why two player records might be the same person ('' = not a candidate).
function pmReason_(a,b){
 if(a.norm&&a.norm===b.norm)return 'Same name';
 if(a.tokens.length>1&&a.tokens.slice().sort().join(' ')===b.tokens.slice().sort().join(' '))return 'Name order swapped';
 var ea=a.email,eb=b.email;if(ea&&ea===eb)return 'Same email';
 if(a.phone&&a.phone===b.phone)return 'Same phone';
 var ca=a.norm.replace(/ /g,''),cb=b.norm.replace(/ /g,'');
 var max=Math.min(ca.length,cb.length)>=12?2:1;
 if(Math.min(ca.length,cb.length)>=5&&pmLev_(ca,cb,max)<=max)return 'Similar spelling';
 if(a.tokens.length>=2&&b.tokens.length>=2){
  var la=a.tokens[a.tokens.length-1],lb=b.tokens[b.tokens.length-1],fa=a.tokens[0],fb=b.tokens[0];
  if(pmLev_(la,lb,la.length>=7?2:1)<=(la.length>=7?2:1)){
   if(fa===fb)return 'Same first name, similar surname';
   if(fa.length>=3&&fb.length>=3&&(fa.indexOf(fb)===0||fb.indexOf(fa)===0))return 'Short / long first name';
   if(fa.charAt(0)===fb.charAt(0)&&(fa.length===1||fb.length===1))return 'Initial only';
   if(fa.charAt(0)===fb.charAt(0)){
    if(la===lb&&(pmLev_(fa,fb,2)<=2||(fa.length>=3&&fb.length>=3&&fa.slice(0,3)===fb.slice(0,3))))return 'Same surname, similar first name';
    if(la!==lb&&pmLev_(fa,fb,1)<=1)return 'Similar first name and surname';
   }
  }
 }
 return '';
}
function pmIgnored_(){try{return JSON.parse(PropertiesService.getScriptProperties().getProperty('DUP_IGNORED')||'[]');}catch(e){return [];}}
function pmPairKey_(a,b){return a<b?a+'|'+b:b+'|'+a;}

function findDuplicatePlayers_(){
 var rows=requireSb_(sbGet_('players','select=player_id,name,email,phone,grade')).data;   // aliases already excluded
 var ignored={};pmIgnored_().forEach(function(k){ignored[k]=true;});
 var ps=rows.map(function(p){var n=pmNorm_(p.name);return {id:p.player_id,name:p.name||'',email:String(p.email||'').trim().toLowerCase(),phone:String(p.phone||'').replace(/\D/g,'').replace(/^61/,'0'),grade:p.grade||'',norm:n,tokens:n?n.split(' '):[]};});
 var parent={};ps.forEach(function(p){parent[p.id]=p.id;});
 function find(x){while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;}
 var reasons={};
 for(var i=0;i<ps.length;i++){for(var j=i+1;j<ps.length;j++){
  var a=ps[i],b=ps[j];if(!a.norm||!b.norm)continue;
  if(ignored[pmPairKey_(a.id,b.id)])continue;
  var r=pmReason_(a,b);if(!r)continue;
  // shared email/phone alone is weak evidence (families share them): only count it with a name hint
  if((r==='Same email'||r==='Same phone')&&!(a.tokens[a.tokens.length-1]===b.tokens[b.tokens.length-1]&&a.tokens[0].charAt(0)===b.tokens[0].charAt(0)))continue;
  parent[find(a.id)]=find(b.id);
  (reasons[a.id]=reasons[a.id]||{})[r]=true;(reasons[b.id]=reasons[b.id]||{})[r]=true;
 }}
 var groups={};ps.forEach(function(p){var g=find(p.id);(groups[g]=groups[g]||[]).push(p);});
 var out=[];
 Object.keys(groups).forEach(function(k){var g=groups[k];if(g.length<2)return;
  // suggest keeping the legacy P#### id if there is one, else the one with most contact detail
  g.sort(function(x,y){var lx=/^P\d+$/.test(x.id)?0:1,ly=/^P\d+$/.test(y.id)?0:1;if(lx!==ly)return lx-ly;var sx=(x.email?1:0)+(x.phone?1:0)+(x.grade?1:0),sy=(y.email?1:0)+(y.phone?1:0)+(y.grade?1:0);if(sx!==sy)return sy-sx;return x.id<y.id?-1:1;});
  var why={};g.forEach(function(p){Object.keys(reasons[p.id]||{}).forEach(function(r){why[r]=true;});});
  out.push({suggestedKeep:g[0].id,reasons:Object.keys(why),players:g.map(function(p){return {id:p.id,name:p.name,email:p.email,phone:p.phone,grade:p.grade,legacy:/^P\d+$/.test(p.id)};})});
 });
 out.sort(function(a,b){return a.players[0].name<b.players[0].name?-1:1;});
 return {ok:true,total:ps.length,groups:out};
}

function ignoreDuplicatePair_(idA,idB){
 idA=String(idA||'');idB=String(idB||'');if(!idA||!idB||idA===idB)throw new Error('Two different players are required.');
 var props=PropertiesService.getScriptProperties(),list=pmIgnored_(),k=pmPairKey_(idA,idB);
 if(list.indexOf(k)<0)list.push(k);
 if(list.length>400)list=list.slice(list.length-400);
 props.setProperty('DUP_IGNORED',JSON.stringify(list));
 return {ok:true};
}
function clearIgnoredDuplicates_(){PropertiesService.getScriptProperties().deleteProperty('DUP_IGNORED');return {ok:true};}

function pmCheckIds_(keepId,dupIds){
 keepId=String(keepId||'').trim();
 if(!keepId)throw new Error('Choose the preferred player.');
 if(!Array.isArray(dupIds))dupIds=[dupIds];
 dupIds=dupIds.map(function(x){return String(x||'').trim();}).filter(function(x,i,a){return x&&a.indexOf(x)===i;});
 if(!dupIds.length)throw new Error('Choose at least one duplicate to merge.');
 if(dupIds.indexOf(keepId)>=0)throw new Error('The preferred player cannot also be a duplicate.');
 if(dupIds.length>10)throw new Error('Merge at most 10 players at a time.');
 return {keep:keepId,dups:dupIds};
}
function previewPlayerMerge_(keepId,dupIds){
 var c=pmCheckIds_(keepId,dupIds),previews=[];
 c.dups.forEach(function(d){previews.push(requireSb_(sbRpc_('cc_player_merge_preview',{p_keep:c.keep,p_dup:d})));});
 return {ok:true,keep:previews[0].keep,previews:previews};
}
function mergePlayers_(keepId,dupIds,deleteDup){
 var c=pmCheckIds_(keepId,dupIds);
 var lock=LockService.getScriptLock();
 if(!lock.tryLock(10000))throw new Error('Another admin change is in progress. Try again in a moment.');
 try{
  var results=[];
  c.dups.forEach(function(d){
   var r=sbRpc_('cc_player_merge',{p_keep:c.keep,p_dup:d,p_delete_dup:!!deleteDup});
   if(r&&r.ok===false)throw new Error('Merging '+d+' failed'+(results.length?' (earlier merges in this batch were completed: '+results.map(function(x){return x.dup;}).join(', ')+')':'')+': '+(r.error||'database error'));
   results.push(r);
  });
  console.info('Players merged into '+c.keep+': '+c.dups.join(',')+' ('+(deleteDup?'deleted':'inactive')+')');
  return {ok:true,keep:c.keep,mode:deleteDup?'deleted':'inactive',results:results};
 }finally{lock.releaseLock();}
}
