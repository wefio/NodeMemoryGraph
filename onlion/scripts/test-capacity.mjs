import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root=process.cwd(),storage=path.join(root,'.sites-runtime/capacity-r2');
fs.rmSync(storage,{recursive:true,force:true});
const modules=[{type:'ESModule',path:root+'/dist/server/index.js'},
 {type:'ESModule',path:root+'/dist/server/sqlite/worker-loader.mjs'},
 {type:'CompiledWasm',path:root+'/dist/server/sqlite/sqlite3.wasm'},
 ...JSON.parse(fs.readFileSync('vendor/sqlite-wasm/callback-list.json')).map(c=>({type:'CompiledWasm',path:root+'/dist/server/sqlite/'+c.name}))];
let failProvider=false,queryCalls=0;
function start(){return new Miniflare({r2Persist:storage,workers:['a','b'].map(name=>({name,
 modules,modulesRoot:root+'/dist/server',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
 bindings:{NMG_API_KEY:'test-key',NMG_OWNER_EMAIL:'owner@example.test',NMG_EMBED_BASE_URL:'https://embedding.test/v1',NMG_EMBED_API_KEY:'local-test',NMG_EMBED_MODEL:'capacity-1024',NMG_EMBED_PROFILE:'plain'},r2Buckets:{MEMORY:'memory'},
 outboundService:async request=>{
  if(failProvider)return new Response('temporary unavailable',{status:503});
  const body=await request.json(),inputs=Array.isArray(body.input)?body.input:[body.input];
  if(inputs.some(x=>String(x).includes('capacity-query')))queryCalls++;
  return Response.json({data:inputs.map((text,index)=>({index,embedding:Array.from({length:1024},(_,i)=>i===0?1:0.0001)}))});
 }}))});}
let mf=start();
async function call(name,route,body,extraHeaders={}){if(route==='/add'&&body)body={session_id:'test-session',...body,messages:body.messages?.map(m=>({role:'user',...m}))};if(route==='/search'&&body)body={top_k:10,...body};const worker=await mf.getWorker(name);const r=await worker.fetch('http://localhost'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer test-key','content-type':'application/json',...extraHeaders},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const hash=text=>createHash('sha256').update(text).digest('hex');
const uid='capacity-user',prefix='users/'+hash(uid).slice(0,24);
let firstTask;
try{
 // Real memory records, FTS indexes and 1024-dimensional persisted vectors.
 for(let i=0;i<100;i++){
  const messages=Array.from({length:20},(_,j)=>({role:'user',content:`Capacity memory ${i*20+j}: robotics project ${i} actuator ${j}. `+'This records an engineering event and its implementation details. '.repeat(8)}));
  const r=await call('a','/add',{user_id:uid,session_id:'session-'+i,request_id:'batch-'+i,messages});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.added,20);firstTask??=r.body.task_id;
  if(i%20===19)console.log(`Ingested ${(i+1)*20} messages`);
 }
 let bucket=await mf.getR2Bucket('MEMORY','a');
 let manifest=await (await bucket.get(prefix+'/manifest.json')).json();
 const bytes=manifest.parts.reduce((sum,p)=>sum+p.bytes,0);
 assert.ok(bytes>16*1024*1024,`Only ${bytes} bytes; increase capacity fixture`);
 assert.ok(manifest.parts.length>1);assert.ok(manifest.parts.every(p=>p.bytes<=8*1024*1024));
 console.log(JSON.stringify({messages:2000,partitions:manifest.parts.length,database_bytes:bytes,largest_partition:Math.max(...manifest.parts.map(p=>p.bytes))}));
 const beforeCalls=queryCalls;
 const found=await call('b','/search',{user_id:uid,query:'capacity-query robotics',top_k:100});
 assert.equal(found.status,200,JSON.stringify(found));assert.ok(found.body.data.length>0);assert.ok(found.body.data.length<=100);assert.equal(found.body.timings.partitions,manifest.parts.length);
 assert.equal(queryCalls-beforeCalls,1,'Query should be embedded once across all partitions');
 assert.equal((await call('b','/add/status/'+firstTask)).body.status,'completed');
 const another=await call('a','/search',{user_id:'other-user',query:'capacity-query robotics',top_k:10});assert.deepEqual(another.body.data,[]);
 // Inspect the actual SQLite image, not just returned API values.
 manifest=await (await bucket.get(prefix+'/manifest.json')).json();
 const image=Buffer.from(await (await bucket.get(manifest.parts[0].key)).arrayBuffer());
 const inspected=spawnSync('python',['-c',`import sys,sqlite3,json
c=sqlite3.connect(':memory:');c.deserialize(sys.stdin.buffer.read())
rows=c.execute('select dimensions,length(vector_blob),vector_json from memory_embeddings').fetchall()
assert any(d==1024 for d,b,j in rows)
assert all(b==d*4 and j=='[]' for d,b,j in rows)
assert not c.execute("select name from sqlite_master where name='memory_fts_content'").fetchone()
assert c.execute("select value from store_metadata where key='fts_storage_format'").fetchone()[0]=='contentless-registry-v1'
assert c.execute('select count(*) from memory_fts_registry where lexical_rowid is null').fetchone()[0]==0
print(json.dumps({'vectors':len(rows),'binary_only':True}))`],{input:image});
 assert.equal(inspected.status,0,inspected.stderr.toString());console.log(inspected.stdout.toString().trim());
 // Provider failure must leave both records and receipt manifest unchanged.
 const oldEtag=(await bucket.head(prefix+'/manifest.json')).etag;failProvider=true;
 const failed=await call('a','/add',{user_id:uid,session_id:'failed',request_id:'failed',messages:[{content:'Do not persist this failed write'}]});assert.equal(failed.status,503);
 assert.equal((await bucket.head(prefix+'/manifest.json')).etag,oldEtag);failProvider=false;
 const parallel=await Promise.all(['a','b'].map((name,i)=>call(name,'/add',{user_id:uid,session_id:'parallel'+i,request_id:'parallel'+i,messages:[{content:'Concurrent partition memory '+i}]})));
 parallel.forEach(r=>assert.equal(r.status,200,JSON.stringify(r)));
 await mf.dispose();mf=start();bucket=await mf.getR2Bucket('MEMORY','a');
 const restored=await call('a','/search',{user_id:uid,query:'capacity-query robotics',top_k:100});assert.equal(restored.status,200);assert.equal(restored.body.timings.partitions,manifest.parts.length);
 // Build a v1 image with a legacy JSON vector and completed-write receipt.
 const legacyUid=manifest.parts[0].scope,legacyKey=hash(legacyUid).slice(0,24),requestHash=hash('legacy-request');
 const response={success:true,user_id:legacyUid,session_id:'legacy-session',request_id:'legacy-request',task_id:legacyKey+'.'+requestHash,status:'completed',added:1};
 const legacy=spawnSync('python',['-c',`import sys,sqlite3,json
c=sqlite3.connect(':memory:');c.deserialize(sys.stdin.buffer.read())
c.execute("CREATE TABLE IF NOT EXISTS cloud_receipts(request_hash TEXT PRIMARY KEY,fingerprint TEXT,response TEXT,completed_at TEXT)")
c.execute('insert or replace into cloud_receipts values(?,?,?,?)',(${JSON.stringify(requestHash)},'old-fingerprint',${JSON.stringify(JSON.stringify(response))},'2026-01-01T00:00:00Z'))
c.execute("DELETE FROM store_metadata WHERE key='vector_storage_format'")
c.execute("UPDATE memory_embeddings SET vector_json='[1,2,3]' WHERE dimensions=1024")
c.commit();sys.stdout.buffer.write(c.serialize())`],{input:image,maxBuffer:16*1024*1024});
 assert.equal(legacy.status,0,legacy.stderr.toString());await bucket.put('users/'+legacyKey+'.sqlite',legacy.stdout);
 assert.equal((await call('a','/add/status/'+response.task_id)).status,200);
 assert.equal((await call('a','/search',{user_id:legacyUid,query:'capacity-query robotics',top_k:10})).status,200);
 assert.equal((await call('a','/add/status/'+response.task_id)).status,200,'Legacy receipt must survive manifest migration');
 const diagnostic=await call('a','/admin/diagnostics/search',{user_id:uid,query:'capacity-query robotics',repetitions:1},{'oai-authenticated-user-email':'owner@example.test',origin:'http://localhost'});
 assert.equal(diagnostic.status,200,JSON.stringify(diagnostic));
 assert.ok('embedding' in diagnostic.body.runs[0].stages_ms);
 assert.ok(!('manifest_commit' in diagnostic.body.runs[0].stages_ms),'Read-only queries skip commit');
 assert.equal(diagnostic.body.runs[0].partitions,manifest.parts.length);
 console.log('PASS: remote embedding timing, multi-partition diagnostic, no unnecessary query commit.');
 console.log('PASS: >16 MiB user, bounded partitions, binary vectors, federated search, single query embedding, isolation, failure atomicity, concurrency, cold restart and legacy migration.');
}finally{await mf.dispose();}
