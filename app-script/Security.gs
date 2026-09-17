// Every browser-callable admin entry point checks a Google identity.
// Only the existing project owner and editor are authorized by default.
function adminEmails_(){
 var configured=PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
 return (configured===null||configured===undefined||configured===''?'wed.squash@gmail.com,justin@masteryournetwork.com.au':configured).toLowerCase().split(',').map(function(s){return s.trim();}).filter(function(s,i,a){return s&&a.indexOf(s)===i;}).sort();
}
function assertAdmin_(){
 var email=String(Session.getActiveUser().getEmail()||'').trim().toLowerCase();
 if(!email)throw new Error('Administrator sign-in required. Google has not supplied your account identity. Open the administrator deployment while signed in to Google.');
 if(adminEmails_().indexOf(email)<0)throw new Error('Administrator sign-in required. Your Google account is not on the administrator list. Ask an existing administrator to add your Google email in the Administrators tab.');
 return email;
}
function getAdminAccess(){
 var email=assertAdmin_();
 return {ok:true,currentEmail:email,emails:adminEmails_()};
}
function changeAdminAccess(action,candidate){
 assertAdmin_();
 var lock=LockService.getScriptLock();
 if(!lock.tryLock(5000))throw new Error('Administrator list is busy. Please try again.');
 try{
  var actor=assertAdmin_(),emails=adminEmails_(),email=String(candidate||'').trim().toLowerCase();
  if(email.length>254||! /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))throw new Error('Enter one valid Google account email address.');
  if(action!=='add'&&action!=='remove')throw new Error('Invalid administrator action.');
  if(action==='remove'&&email===actor)throw new Error('You cannot remove your own administrator access.');
  var index=emails.indexOf(email);
  if(action==='add'&&index<0){if(emails.length>=25)throw new Error('The administrator list is limited to 25 accounts.');emails.push(email);}
  if(action==='remove'&&index>=0)emails.splice(index,1);
  if(!emails.length)throw new Error('At least one administrator must remain.');
  emails.sort();
  PropertiesService.getScriptProperties().setProperty('ADMIN_EMAILS',emails.join(','));
  console.info('Administrator access '+action+' by '+actor+': '+email);
  return {ok:true,currentEmail:actor,emails:emails};
 }finally{lock.releaseLock();}
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
