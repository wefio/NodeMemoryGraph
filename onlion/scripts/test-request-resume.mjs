/* eslint-disable no-console -- deliberate test/diagnostic output */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root=process.cwd(), storage=path.join(root,'.sites-runtime/resume-r2');
fs.rmSync(storage,{recursive:true,force:true});
const modules=[{type:'ESModule',path:root+'/dist/server/index.js'},
  {type:'ESModule',path:root+'/dist/server/sqlite/worker-loader.mjs'},
  {type:'CompiledWasm',path:root+'/dist/server/sqlite/sqlite3.wasm'},
  {type:'CompiledWasm',path:root+'/dist/server/sqlite/callbacks.wasm'}];
let queryBlock, documentBlock;
const requestsByText=new Map();
function start(){return new Miniflare({r2Persist:storage,modules,modulesRoot:root+'/dist/server',
  compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  bindings:{NMG_API_KEY:'test-key',NMG_EMBED_BASE_URL:'https://embedding.test/v1',NMG_EMBED_API_KEY:'test',NMG_EMBED_MODEL:'resume-test',NMG_EMBED_PROFILE:'plain'},
  r2Buckets:{MEMORY:'memory'},
  outboundService:async request=>{
    const body=await request.json(), inputs=body.input;
    for(const text of inputs)requestsByText.set(text,(requestsByText.get(text)||0)+1);
    for(const [marker,gate] of [['blocked-query',queryBlock],['blocked-document',documentBlock]]){
      if(gate&&!gate.used&&inputs.some(text=>text.includes(marker))){gate.used=true;gate.started.resolve();await gate.release.promise;}
    }
    return Response.json({data:inputs.map((_,index)=>({index,embedding:[1,0,0,0]}))});
  }});}
function gate(){return {started:Promise.withResolvers(),release:Promise.withResolvers(),used:false};}
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Independent request was blocked')),3000);})]);}finally{clearTimeout(timer);}}
let mf=start();
async function call(route,body,signal){const r=await mf.dispatchFetch('http://localhost'+route,{method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'},body:JSON.stringify(body),signal});return {status:r.status,body:await r.json()};}
const search=(query)=>call('/search',{user_id:'seed',query,top_k:10});
try{
  assert.equal((await call('/add',{user_id:'seed',session_id:'s',request_id:'seed',messages:[{role:'user',content:'Atlas is my favorite robot.'}]})).status,200);
  queryBlock=gate();
  const controller=new AbortController();
  const interrupted=call('/search',{user_id:'seed',query:'blocked-query robot',top_k:10},controller.signal).catch(()=>null);
  await within(queryBlock.started.promise);
  assert.equal((await within(search('favorite robot'))).status,200);
  controller.abort();queryBlock.release.resolve();await within(interrupted);
  assert.equal((await within(search('Atlas robot'))).status,200);
  console.log('PASS: a waiting/cancelled query does not block independent requests.');
  await search('unique-cached-query robot');await search('unique-cached-query robot');
  assert.equal([...requestsByText].filter(([text])=>text.includes('unique-cached-query')).reduce((sum,[,count])=>sum+count,0),1);
  console.log('PASS: repeated queries reuse completed vectors without sharing in-flight I/O.');
  documentBlock=gate();
  const addController=new AbortController();
  const input={user_id:'resume',session_id:'s',request_id:'stable-retry',messages:[{role:'user',content:'blocked-document robot Spot.'}]};
  const pending=call('/add',input,addController.signal).catch(()=>null);
  await within(documentBlock.started.promise);
  assert.equal((await within(search('robot Atlas'))).status,200);
  addController.abort();documentBlock.release.resolve();await within(pending);
  const completed=await within(call('/add',input));assert.equal(completed.status,200,JSON.stringify(completed));
  assert.deepEqual(await call('/add',input),completed);
  await mf.dispose();mf=start();
  assert.deepEqual(await within(call('/add',input)),completed);
  const recalled=await call('/search',{user_id:'resume',query:'robot Spot',top_k:10});
  assert.equal(recalled.status,200);assert.equal(recalled.body.data.length,1);
  console.log('PASS: interrupted Add retries once, survives cold restart, and does not duplicate records.');
}finally{queryBlock?.release.resolve();documentBlock?.release.resolve();await mf.dispose();}
