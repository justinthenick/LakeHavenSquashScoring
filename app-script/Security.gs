// Every browser-callable admin entry point checks a Google identity.
// Only the existing project owner and editor are authorized by default.
function assertAdmin_(){
 var email=String(Session.getActiveUser().getEmail()||'').toLowerCase();
 var configured=PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
 var allowed=(configured||'wed.squash@gmail.com,justin@masteryournetwork.com.au').toLowerCase().split(',').map(function(s){return s.trim();});
 if(!email||allowed.indexOf(email)<0)throw new Error('Administrator sign-in required. Open the private admin deployment with an authorized Google account.');
 return email;
}
// The short code is used only for device enrollment, never for result requests.
// A global limit is required: Apps Script does not provide a trusted client IP.
function clubCode_(props){
 var code=props.getProperty('CLUB_ACCESS_CODE')||'';
 if(!/^[A-Za-z0-9]{4}$/.test(code)&&code.length<16)throw new Error('Scorer access is not configured. Ask the administrator to set a four-character club code.');
 return code;
}
function deviceSignature_(data,key,code){
 return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(data+'|'+code,key)).replace(/=+$/,'');
}
function authorizeDevice_(candidate){
 var lock=LockService.getScriptLock();
 if(!lock.tryLock(3000))throw new Error('Club access is busy. Please try again shortly.');
 try{
  var props=PropertiesService.getScriptProperties(),code=clubCode_(props),now=Date.now();
  var attempts=JSON.parse(props.getProperty('CLUB_LOGIN_ATTEMPTS')||'{}');
  if(attempts.until>now&&attempts.failures>=5)throw new Error('Too many incorrect club codes. New-device sign-in is paused for up to 15 minutes; already-connected devices can keep scoring.');
  if(!(attempts.until>now))attempts={until:now+15*60*1000,failures:0};
  if(String(candidate||'')!==code){
   attempts.failures++;props.setProperty('CLUB_LOGIN_ATTEMPTS',JSON.stringify(attempts));
   throw new Error('Invalid club access code. Check the code with your administrator.');
  }
  // Do not reset failed attempts on success: another valid device must not
  // accidentally let an attacker reset the shared guessing budget.
  var key=props.getProperty('CLUB_DEVICE_SIGNING_KEY');
  if(!key){key=Utilities.getUuid()+Utilities.getUuid();props.setProperty('CLUB_DEVICE_SIGNING_KEY',key);}
  var data='cc1.'+(now+180*24*60*60*1000)+'.'+Utilities.getUuid();
  return {ok:true,token:data+'.'+deviceSignature_(data,key,code)};
 }finally{lock.releaseLock();}
}
function requireClubCode_(candidate){
 var props=PropertiesService.getScriptProperties(),code=clubCode_(props),key=props.getProperty('CLUB_DEVICE_SIGNING_KEY');
 var token=String(candidate||''),parts=token.split('.');
 if(!key||parts.length!==4||parts[0]!=='cc1'||!/^\d+$/.test(parts[1])||Number(parts[1])<=Date.now())throw new Error('Device access expired or missing. Enter the club access code in Settings.');
 var expected=deviceSignature_(parts.slice(0,3).join('.'),key,code),difference=expected.length^parts[3].length;
 for(var i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^(parts[3].charCodeAt(i)||0);
 if(difference)throw new Error('Invalid device access. Enter the club access code in Settings.');
}
function getActiveComps(){assertAdmin_();return getActiveComps_.apply(null,arguments);}
function getDrawCalendar(){assertAdmin_();return getDrawCalendar_.apply(null,arguments);}
function getAllComps(){assertAdmin_();return getAllComps_.apply(null,arguments);}
function cloneComp(){assertAdmin_();return cloneComp_.apply(null,arguments);}
function resolveFixtures(){assertAdmin_();return resolveFixtures_.apply(null,arguments);}
function extractSheet(){assertAdmin_();return extractSheet_.apply(null,arguments);}
function commitResults(){assertAdmin_();return commitResults_.apply(null,arguments);}
function existingResults(){assertAdmin_();return existingResults_.apply(null,arguments);}
function getStandings(){assertAdmin_();return getStandings_.apply(null,arguments);}
function getCompReport(){assertAdmin_();return getCompReport_.apply(null,arguments);}
function getDrawUrl(){assertAdmin_();return getDrawUrl_.apply(null,arguments);}
function getRoster(){assertAdmin_();return getRoster_.apply(null,arguments);}
function saveRoster(){assertAdmin_();return saveRoster_.apply(null,arguments);}
function listRoundsWithResults(){assertAdmin_();return listRoundsWithResults_.apply(null,arguments);}
function getRallyLog(){assertAdmin_();return getRallyLog_.apply(null,arguments);}
function getCommittedRubbers(){assertAdmin_();return getCommittedRubbers_.apply(null,arguments);}
function deleteRubbers(){assertAdmin_();return deleteRubbers_.apply(null,arguments);}
function getContacts(){assertAdmin_();return getContacts_.apply(null,arguments);}

function getOutputConfig(){assertAdmin_();return getOutputConfig_.apply(null,arguments);}

function saveOutputConfig(){assertAdmin_();return saveOutputConfig_.apply(null,arguments);}

function previewRoundOutput(){assertAdmin_();return previewRoundOutput_.apply(null,arguments);}

function sendRoundOutput(){assertAdmin_();return sendRoundOutput_.apply(null,arguments);}
