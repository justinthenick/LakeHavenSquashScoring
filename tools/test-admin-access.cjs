const fs=require('fs'),vm=require('vm'),assert=require('assert');
let acorn;try{acorn=require('acorn');}catch(e){acorn=require('./package/dist/acorn.js');}
const source=fs.readFileSync('app-script/Security.gs','utf8');
let email='',props={},held=false,busy=false,onLock=null,count=0;
const ctx={Session:{getActiveUser:()=>({getEmail:()=>email})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>props[k]=v})},LockService:{getScriptLock:()=>({tryLock:()=>{if(busy)return false;held=true;if(onLock)onLock();return true;},releaseLock:()=>held=false})},console:{info(){}},Date,JSON};
vm.createContext(ctx);vm.runInContext(source,ctx);
function check(name,fn){fn();assert(!held);console.log('PASS '+name);count++;}
check('anonymous and unlisted users cannot read or mutate access',()=>{for(const who of ['', 'outsider@example.com']){email=who;assert.throws(()=>ctx.getAdminAccess(),/sign-in required/);assert.throws(()=>ctx.changeAdminAccess('add',who),/sign-in required/);}assert.deepEqual(props,{});});
email='wed.squash@gmail.com';
check('default accounts preserved when adding normalized Google email',()=>{const r=ctx.changeAdminAccess('add',' NEW@Example.com ');assert.deepEqual(Array.from(r.emails),['justin@masteryournetwork.com.au','new@example.com','wed.squash@gmail.com']);assert.equal(r.currentEmail,email);});
check('retries cannot duplicate an admin',()=>{ctx.changeAdminAccess('add','new@example.com');assert.equal(ctx.getAdminAccess().emails.length,3);});
check('new admin can manage access, removal revokes next request',()=>{email='new@example.com';ctx.changeAdminAccess('add','second@example.com');email='wed.squash@gmail.com';ctx.changeAdminAccess('remove','new@example.com');email='new@example.com';assert.throws(()=>ctx.getAdminAccess(),/not on/);email='wed.squash@gmail.com';assert(ctx.getAdminAccess().emails.includes('second@example.com'));});
check('self removal and malformed input leave list unchanged',()=>{const before=props.ADMIN_EMAILS;for(const bad of ['x','a@example.com,b@example.com','a@example.com\nb@example.com','a@-example.com','a@example..com'])assert.throws(()=>ctx.changeAdminAccess('add',bad),/valid/);assert.throws(()=>ctx.changeAdminAccess('remove',email),/own/);assert.throws(()=>ctx.changeAdminAccess('replace','valid@example.com'),/Invalid/);assert.equal(props.ADMIN_EMAILS,before);});
check('property override respected, removed defaults never reappear',()=>{props.ADMIN_EMAILS='second@example.com';email='second@example.com';ctx.changeAdminAccess('add','third@example.com');assert(!ctx.getAdminAccess().emails.includes('wed.squash@gmail.com'));});
check('authorization rechecked after acquiring shared lock',()=>{onLock=()=>{props.ADMIN_EMAILS='third@example.com';};assert.throws(()=>ctx.changeAdminAccess('add','fourth@example.com'),/not on/);assert.equal(props.ADMIN_EMAILS,'third@example.com');onLock=null;email='third@example.com';});
check('busy list cannot be changed',()=>{busy=true;assert.throws(()=>ctx.changeAdminAccess('add','fourth@example.com'),/busy/);busy=false;assert.equal(props.ADMIN_EMAILS,'third@example.com');});
check('list cannot exceed safe property size',()=>{props.ADMIN_EMAILS=['third@example.com',...Array.from({length:24},(_,i)=>'admin'+i+'@example.com')].join(',');assert.throws(()=>ctx.changeAdminAccess('add','overflow@example.com'),/25/);assert.equal(ctx.getAdminAccess().emails.length,25);});
check('admin HTML script parses and tab works without a competition',()=>{const html=fs.readFileSync('app-script/Admin.html','utf8');acorn.parse(html.match(/<script>([\s\S]*?)<\/script>/)[1],{ecmaVersion:2022});assert(html.includes("if(id==='admins')loadAdminAccess();"));});
console.log(count+' administrator access checks passed');
