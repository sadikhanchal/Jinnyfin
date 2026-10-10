import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
const ROOT=join(dirname(fileURLToPath(import.meta.url)), '..');
const source=fs.readFileSync(process.env.STORE_SOURCE || join(ROOT,'js/store.js'),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
const tests=[];const test=(name,fn)=>tests.push({name,fn});
async function setup(factory = new IDBFactory()){
 const messages=[], server=new Map();let revoked=0, calls=0;
 const control={error:null,hang:false,hold:null,onPull:null};
 const navigator={onLine:false}; const storage=new Map();
 const sb={auth:{signOut:async()=>{revoked++;return {error:null}}},from(table){
  let rows=null;
  const query={upsert(r){rows=r;return this},select(){return this},gt(){return this},order(){return this},range(){return this},abortSignal(signal){this.signal=signal;return this},then(resolve,reject){
   calls++;
   (async()=>{
    if(control.hang) return await new Promise((_,rej)=>this.signal.addEventListener('abort',()=>rej(Error('Aborted'))));
    if(rows){if(control.hold)await control.hold;if(control.error)return {error:control.error};for(const r of rows)server.set(table+':'+r.id,{...r});return {error:null};}
    if(control.onPull)await control.onPull(table);
    return {data:[...server].filter(([k])=>k.startsWith(table+':')).map(([,r])=>r),error:null};
   })().then(resolve,reject);
  }};return query;
 }};
 const context=vm.createContext({console:{warn(){},error(){}},navigator,indexedDB:factory,CONFIG:{SUPABASE_URL:'',SUPABASE_ANON_KEY:''},uuid:randomUUID,todayISO:()=> '2026-10-10',toast:(...a)=>messages.push(a),safeStore:(k,v)=>v===undefined?storage.get(k):(v===null?storage.delete(k):storage.set(k,v)),storageBlocked:()=>false,window:{addEventListener(){}},document:{addEventListener(){},hidden:false},localStorage:{length:0,key(){},removeItem(){}},location:{origin:'http://local',pathname:'/'},AbortController,Date,Map,Set,Promise,setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms===20000?50:ms);t.unref();return t},clearTimeout});
 vm.runInContext(source+'\nglobalThis.S={DB,state,boot,put,putMany,sync,signOut,resetLocal,queueAll};globalThis.getIDB=()=>idb;',context);
 const S=context.S;S.state.sb=sb;await S.boot();S.state.user={id:'fixture-user'};navigator.onLine=true;
 return {S,context,navigator,control,messages,server,get revoked(){return revoked},get calls(){return calls}};
}
const row=(id,note='local')=>({id,note,type:'Expense',date:'2026-10-10',expense:1,currency:'SAR'});
test('all historical queue versions drain after latest version succeeds',async()=>{const e=await setup();await e.S.put('transactions',row('a','old'),{silent:true});await e.S.put('transactions',row('a','new'),{silent:true});const result=await e.S.sync();assert.equal(result.ok,true);assert.equal(e.S.state.pending,0);assert.equal((await e.S.queueAll()).length,0);assert.equal(e.server.get('transactions:a').note,'new');});
test('network failure returns failure, keeps entries and blocks direct sign-out',async()=>{const e=await setup();await e.S.put('transactions',row('a'),{silent:true});e.control.error={message:'Failed to fetch'};const r=await e.S.sync();assert.equal(r.ok,false);assert.match(e.S.state.syncError,/Failed to fetch/);await assert.rejects(e.S.signOut(),/blocked/);assert.equal(e.revoked,0);assert.equal(e.S.DB.transactions.length,1);assert.equal((await e.S.queueAll()).length,1);assert.equal(e.S.state.user.id,'fixture-user');});
test('offline returns truthful status and protects queue against reset',async()=>{const e=await setup();await e.S.put('transactions',row('a'),{silent:true});e.navigator.onLine=false;assert.equal((await e.S.sync()).ok,false);await assert.rejects(e.S.resetLocal(),/pending/);assert.equal(e.S.DB.transactions.length,1);});
test('schema mismatch never clears a partial-field upload',async()=>{const e=await setup();await e.S.put('transactions',row('a'),{silent:true});e.control.error={message:"Could not find the 'note' column of 'transactions'"};const r=await e.S.sync();assert.equal(r.ok,false);assert.equal(e.S.state.pending,1);assert.match(e.S.state.syncError,/schema/);assert.equal(e.server.size,0);});
test('bad row stays queued while healthy rows upload',async()=>{const e=await setup();await e.S.putMany('transactions',[row('a'),row('b')]);const original=e.S.state.sb.from;e.S.state.sb.from=table=>{const q=original(table);const up=q.upsert;q.upsert=function(rows){if(rows.some(r=>r.id==='a')){this.then=(res)=>Promise.resolve({error:{message:'invalid row'}}).then(res);return this}return up.call(this,rows)};return q;};const r=await e.S.sync();assert.equal(r.ok,false);assert.equal((await e.S.queueAll()).length,1);assert.equal(e.server.get('transactions:b').id,'b');});
test('concurrent sync callers share completion and preserve edits made in flight',async()=>{const e=await setup();await e.S.put('transactions',row('a','old'),{silent:true});let release;e.control.hold=new Promise(r=>release=r);const first=e.S.sync(),second=e.S.sync();assert.equal(first,second);await new Promise(r=>setTimeout(r,5));await e.S.put('transactions',row('a','new'),{silent:true});release();await first;assert.equal(e.S.state.pending,1);assert.equal(e.S.DB.transactions[0].note,'new');e.control.hold=null;assert.equal((await e.S.sync()).ok,true);assert.equal(e.S.state.pending,0);assert.equal(e.server.get('transactions:a').note,'new');});
test('hung network releases syncing state and retains pending work',async()=>{const e=await setup();await e.S.put('transactions',row('a'),{silent:true});e.control.hang=true;assert.equal((await e.S.sync()).ok,false);assert.equal(e.S.state.syncing,false);assert.equal(e.S.state.pending,1);e.control.hang=false;assert.equal((await e.S.sync()).ok,true);});
test('save and queue are atomic, aborted transaction changes neither memory nor disk',async()=>{const e=await setup();const db=e.context.getIDB(),tx=db.transaction.bind(db);let aborted=false;db.transaction=(stores,mode)=>{const t=tx(stores,mode);if(mode==='readwrite'&&stores.includes('transactions')&&stores.includes('_queue')&&!aborted){aborted=true;queueMicrotask(()=>t.abort());}return t;};await assert.rejects(e.S.put('transactions',row('a'),{silent:true}));assert.equal(e.S.DB.transactions.length,0);assert.equal((await e.S.queueAll()).length,0);const rows=await new Promise((res,rej)=>{const r=db.transaction('transactions').objectStore('transactions').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});assert.equal(rows.length,0);});
test('successful retry allows sign-out and privacy purge',async()=>{const e=await setup();await e.S.put('transactions',row('a'),{silent:true});await e.S.sync();await e.S.signOut();assert.equal(e.revoked,1);assert.equal(e.S.state.user,null);assert.equal(e.S.DB.transactions.length,0);assert.equal((await e.S.queueAll()).length,0);});
test('pending queue read failure must fail closed before sign-out',async()=>{const e=await setup();const db=e.context.getIDB(),tx=db.transaction.bind(db);db.transaction=(stores,mode)=>{if(stores.includes('_queue')&&!mode){throw Error('storage read failure')}return tx(stores,mode)}; // readonly mode is explicitly passed
 db.transaction=(stores,mode)=>{if(stores.includes('_queue')&&mode==='readonly')throw Error('storage read failure');return tx(stores,mode)};
 await assert.rejects(e.S.signOut(),/storage read failure/);assert.equal(e.revoked,0);assert.equal(e.S.state.user.id,'fixture-user');});
test('save guard blocks writes during sign-out',async()=>{const e=await setup();e.S.state.signingOut=true;await assert.rejects(e.S.put('transactions',row('a'),{silent:true}),/Sign-out/);assert.equal(e.S.DB.transactions.length,0);});
test('pending entries survive a fresh app boot in durable storage',async()=>{const factory=new IDBFactory();const e=await setup(factory);await e.S.put('transactions',row('a'),{silent:true});const reloaded=await setup(factory);assert.equal(reloaded.S.state.pending,1);assert.equal(reloaded.S.DB.transactions[0].id,'a');assert.equal((await reloaded.S.queueAll()).length,1);});
test('an edit arriving during pull is never overwritten by the server',async()=>{const e=await setup();e.server.set('transactions:a',row('a','remote'));let edited=false;e.control.onPull=async table=>{if(table==='transactions'&&!edited){edited=true;await e.S.put('transactions',row('a','new local'),{silent:true});}};await e.S.sync();assert.equal(e.S.DB.transactions[0].note,'new local');assert.equal(e.S.state.pending,1);});
test('UI contains no discard escape hatch or unconditional success toast',async()=>{const app=fs.readFileSync(join(ROOT,'js/app.js'),'utf8'),settings=fs.readFileSync(join(ROOT,'js/views/settings.js'),'utf8');assert.ok(!app.includes('Delete changes and sign out'));assert.ok(!settings.includes("sync().then(() => toast('Synced'))"));assert.ok(settings.includes('result?.ok'));});
const keepAlive=setInterval(()=>{},1000);let failed=0;for(const t of tests){try{await t.fn();console.log('PASS '+t.name)}catch(e){failed++;console.error('FAIL '+t.name,e)}}clearInterval(keepAlive);console.log(`${tests.length-failed}/${tests.length} passed`);process.exitCode=failed?1:0;
