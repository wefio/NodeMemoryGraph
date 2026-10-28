import {measure, measureSync} from './diagnostics.mjs';
import {applyPageDelta, makePageDelta, deltaBytes} from './page-delta.mjs';
import {createHash} from 'node:crypto';
import {DatabaseSync, withDatabases} from './sqlite.mjs';
import {EmbeddingPreparation} from './embedding-session.mjs';
import {logPrefix} from './append-log.mjs';

export const USER_LIMIT=1024*1024*1024;
export const PART_LIMIT=8*1024*1024;
export const PART_TARGET=6*1024*1024;
export const MAX_PARTS=128;
export const MAX_RECEIPTS=16384;
export const MAX_MANIFEST_BYTES=16*1024*1024;
// v4 is v2/v3 plus a pending log. It is only written while `pending` is non-zero,
// so a user whose log is empty keeps the exact bytes an older deployment wrote.
export const STORAGE_FORMAT_V4='nmg-shards-v4';
const STORAGE_FORMATS=['nmg-shards-v2','nmg-shards-v3',STORAGE_FORMAT_V4];
export const keyFor=text=>createHash('sha256').update(text).digest('hex').slice(0,24);
export class StorageError extends Error {
  constructor(code,message,status=413){super(message);this.code=code;this.status=status;}
}
const manifestKey=key=>`users/${key}/manifest.json`;
/** Entries still in the log. Absent or zero means nothing is pending. */
export function pendingCount(manifest){
  const count=manifest?.pending??0;
  return Number.isSafeInteger(count)&&count>0?count:0;
}
/** Shallow copy of `manifest` carrying `count` pending entries; `receipts` is
 *  shared, as everywhere else in this module. A zero count removes the key
 *  entirely: `pending: 0` on its own would already change the stored bytes. */
export function withPending(manifest,count){
  if(!Number.isSafeInteger(count)||count<0)throw new TypeError('pending count must be a non-negative integer');
  const next={...manifest};
  if(count)next.pending=count;else delete next.pending;
  return next;
}
/** Format to store. Pending entries make the manifest unreadable to a
 *  deployment that predates the log, which is the correct failure mode. */
export function manifestFormat(manifest){
  if(pendingCount(manifest)>0)return STORAGE_FORMAT_V4;
  return manifest.parts.some(p=>p.delta)?'nmg-shards-v3':'nmg-shards-v2';
}
export async function loadManifest(bucket,key,userId){
  const object=await bucket.get(manifestKey(key));
  if(object){
    if(object.size>MAX_MANIFEST_BYTES)throw new StorageError('user_storage_limit','User manifest exceeds 16 MiB');
    const manifest=await object.json();
    if(!STORAGE_FORMATS.includes(manifest.format)||!Array.isArray(manifest.parts))throw new StorageError('storage_corrupt','Unsupported user storage format',503);
    // A forged or truncated count would silently skip folding, so treat it as
    // corruption instead of reading it as zero.
    if(manifest.pending!==undefined&&(!Number.isSafeInteger(manifest.pending)||manifest.pending<0))throw new StorageError('storage_corrupt','Invalid pending count in user manifest',503);
    return {object,manifest};
  }
  const legacy=await bucket.head(`users/${key}.sqlite`);
  return {object:null,manifest:{format:'nmg-shards-v2',parts:legacy?[{scope:userId,key:`users/${key}.sqlite`,bytes:legacy.size}]:[],receipts:{}}};
}
export function newPart(userId){return {scope:`${userId}\0nmg-part:${crypto.randomUUID()}`,key:null,bytes:0};}
export async function runPart(bucket,part,sqlite,operation,options={}){
  for (;;) {
    try { return await openPart(bucket,part,sqlite,operation,options); }
    catch (error) {
      if (!(error instanceof EmbeddingPreparation)) throw error;
      // openPart has unwound: no live SQLite connection or image is retained
      // by the network operation, and nothing has been durably committed.
      await error.prepare();
    }
  }
}
function changeStamp(connection){
  return JSON.stringify([connection.prepare('SELECT total_changes() AS n').get().n,
    ...['schema_version','user_version','application_id','journal_mode'].map(name=>connection.prepare('PRAGMA '+name).get())]);
}
async function openPart(bucket,part,sqlite,operation,options){
  const object=part.key?await measure('partition_read',()=>bucket.get(part.key)):null;
  if(part.key&&!object)throw new StorageError('snapshot_changed','Snapshot was replaced; retry',503);
  // Legacy snapshots retain the previous 16 MiB ceiling during migration.
  if(object?.size>16*1024*1024)throw new StorageError('part_storage_limit','Legacy snapshot exceeds 16 MiB');
  const key=keyFor(part.scope);
  let image=object?new Uint8Array(await measure('partition_download',()=>object.arrayBuffer())):undefined;
  if(image)image=measureSync('delta_restore',()=>applyPageDelta(image,part,true));
  return withDatabases(new Map(image?[[`${key}.sqlite`,image]]:[]),async()=>{
    const connection=measureSync('sqlite_load',()=>new DatabaseSync(`/tmp/nmg/${key}.sqlite`));
    const before=options.readOnlyIfUnchanged?changeStamp(connection):null;
    const result=await operation({connection,key,scope:part.scope});
    if(result.readOnly)return result;
    // Data changes and persistent schema/header settings cover this service's
    // query paths. Schema migration or embedding backfill still exports and
    // commits normally; an ordinary pure query never copies the full image.
    if(before!==null&&before===changeStamp(connection))
      return {...result,readOnly:true,legacyReceipts:[]};
    const oldReceipts=connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_receipts'").get();
    const legacyReceipts=oldReceipts?connection.prepare('SELECT request_hash,fingerprint,response,completed_at FROM cloud_receipts').all():[];
    const snapshot=measureSync('sqlite_export',()=>sqlite.capi.sqlite3_js_db_export(connection.db));
    if(snapshot.byteLength>16*1024*1024)throw new StorageError('part_storage_limit','Snapshot exceeds working-memory limit');
    return {...result,snapshot,legacyReceipts,previousImage:image};
  });
}
/** Uploads one partition snapshot.
 *
 *  `reuse` lets a single request skip an upload it already made for
 *  byte-identical content. A manifest CAS conflict retries the whole operation, so
 *  without it every retry paid for another multi-megabyte snapshot upload, which
 *  was the dominant cost of concurrent Adds on one user. Content is compared, not
 *  assumed deterministic. */
export async function stagePart(bucket,userKey,part,snapshot,reuse){
  const fingerprint=reuse?`${part.scope}\n${createHash('sha256').update(snapshot).digest('hex')}`:null;
  const prior=fingerprint?reuse.get(fingerprint):null;
  if(prior)return {...part,key:prior,bytes:snapshot.byteLength};
  const key=`users/${userKey}/parts/${crypto.randomUUID()}.sqlite`;
  await measure('partition_save',()=>bucket.put(key,snapshot,{httpMetadata:{contentType:'application/vnd.sqlite3'},customMetadata:{format:'nmg-part-v2'}}));
  if(fingerprint)reuse.set(fingerprint,key);
  const base={...part};
  delete base.delta;
  return {...base,key,bytes:snapshot.byteLength};
}
export async function stageSearchPart(bucket,userKey,part,result,userBudget,fullSnapshot=false){
  const patch=fullSnapshot?null:measureSync('delta_encode',()=>makePageDelta(part,result.previousImage,result.snapshot,userBudget));
  if(patch)return {...patch,mode:patch.changed?'inline_page_delta':'unchanged',stagedKey:null};
  const saved=await stagePart(bucket,userKey,part,result.snapshot);
  return {part:saved,mode:'full_snapshot',stagedKey:saved.key,changed:true,changedPages:0,inlineBytes:0};
}
export async function commitManifest(bucket,key,previous,manifest){
  // Older deployments must reject overlay manifests rather than silently load
  // the stale base snapshot. Fully compacted manifests remain v2-compatible.
  // The same laziness keeps a drained log byte-identical to v2/v3.
  if(!pendingCount(manifest))delete manifest.pending;
  manifest.format=manifestFormat(manifest);
  if(manifest.parts.length>MAX_PARTS||manifest.parts.reduce((sum,p)=>sum+p.bytes,0)>USER_LIMIT)
    throw new StorageError('user_storage_limit','User exceeds 1 GiB or 128 storage partitions');
  if(Object.keys(manifest.receipts).length>MAX_RECEIPTS)throw new StorageError('request_receipt_limit','User exceeds 16384 distinct Add requests');
  const body=JSON.stringify(manifest);
  if(new TextEncoder().encode(body).length>MAX_MANIFEST_BYTES)throw new StorageError('user_storage_limit','User manifest exceeds 16 MiB');
  return bucket.put(manifestKey(key),body,{onlyIf:previous?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
}
/** Deletes every pending log entry for one user. Reset is the only caller and
 *  runs it after the generation barrier is committed, so a fold racing the reset
 *  cannot fold these entries anyway (I4). The prefix comes from append-log.mjs so
 *  the two modules cannot drift apart. Returns the number of objects removed; a
 *  second call removes nothing, which is what makes retrying a reset safe. */
export async function clearLog(bucket,userKey){
  const prefix=logPrefix(userKey);
  let removed=0, cursor;
  for(;;){
    const page=await bucket.list({prefix,cursor,limit:1000});
    const keys=(page?.objects??[]).map(object=>object.key).filter(key=>typeof key==='string'&&key.startsWith(prefix)&&key.length>prefix.length);
    if(keys.length){await bucket.delete(keys);removed+=keys.length;}
    if(!page?.truncated||!page.cursor)break;
    cursor=page.cursor;
  }
  return removed;
}
export async function removeStaged(bucket,keys){
  if(keys.length)await bucket.delete(keys);
}
export async function retireParts(bucket,before,after){
  const live=new Set(after.parts.map(p=>p.key));
  // Keep the original v1 image as a rollback copy. v2 superseded images may be
  // removed only after the new manifest is committed; racing readers retry.
  const retired=before.parts.map(p=>p.key).filter(k=>k&&k.includes('/parts/')&&!live.has(k));
  if(retired.length)await bucket.delete(retired).catch(()=>{});
}

// Read one manifest (or HEAD a legacy image). Never open SQLite, fetch shards,
// list bucket objects, invoke a model, write data or start a background task.
export async function userCapacity(bucket,userId){
  const {object,manifest}=await loadManifest(bucket,keyFor(userId),userId);
  const legacy=!object&&manifest.parts.length>0;
  const quota=(used,limit)=>({used,limit,remaining:used===null?null:Math.max(0,limit-used),percent:used===null?null:Math.round(10000*used/limit)/100});
  const bytes=manifest.parts.reduce((sum,p)=>sum+p.bytes,0);
  const last=manifest.parts.at(-1);
  const sqlite=quota(bytes,USER_LIMIT),partitions=quota(manifest.parts.length,MAX_PARTS);
  const requests=quota(legacy?null:Object.keys(manifest.receipts).length,MAX_RECEIPTS);
  const metadata=quota(object?.size??0,MAX_MANIFEST_BYTES);
  const warnings=[];
  for(const [name,value] of Object.entries({sqlite_bytes:sqlite,partitions,add_requests:requests,manifest_bytes:metadata})){
    if(value.used!==null&&value.used>=value.limit*0.8)warnings.push({resource:name,level:value.used>=value.limit?'limit_reached':'near_limit'});
  }
  return {user_id:userId,checked_at:new Date().toISOString(),source:legacy?'legacy_object_head':'manifest',
    exists:!!object||legacy,sqlite_bytes:sqlite,partitions,add_requests:requests,manifest_bytes:metadata,
    inline_delta_bytes:manifest.parts.reduce((sum,p)=>sum+deltaBytes(p),0),
    active_partition:{bytes:last?.bytes??0,target_bytes:PART_TARGET,max_add_bytes:PART_LIMIT,
      target_headroom_bytes:last?Math.max(0,PART_TARGET-last.bytes):PART_TARGET},
    warnings,notes:[
      'SQLite bytes describe current logical images, including restored overlays; not total billed bucket usage.',
      'No exact memory count is collected. Add requests count distinct durable receipts, not messages or memories.',
      'Remaining byte quota does not guarantee another Add fits; rollover, request size and metadata limits also apply.',
      ...(legacy?['Legacy receipt count is unknown until the existing image is imported by a normal operation.']:[])]};
}

// Emergency per-user reset. The empty manifest remains as a generation barrier:
// stale writers cannot restore old pointers, and a legacy image cannot reappear.
function resetManifestState(manifest,resetId,key){
  const receiptKey=createHash('sha256').update(resetId).digest('hex');
  const keys=[...new Set([...(manifest.reset?.pending_keys??[]),...manifest.parts.map(p=>p.key).filter(Boolean),`users/${key}.sqlite`])];
  const empty={format:'nmg-shards-v2',generation:crypto.randomUUID(),parts:[],receipts:{},
    reset:{id:resetId,at:new Date().toISOString(),pending_keys:keys},
    reset_receipts:{...manifest.reset_receipts,[receiptKey]:new Date().toISOString()}};
  return {receiptKey,empty};
}
async function clearResetPendingKeys(bucket,key,userId,current){
  const pending=current.reset.pending_keys??[];
  let cleanupComplete=true;
  try{for(let i=0;i<pending.length;i+=1000)await bucket.delete(pending.slice(i,i+1000));}
  catch{cleanupComplete=false;}
  if(cleanupComplete&&pending.length){
    // Preserve any new Add that committed after the reset. Clearing this list
    // is metadata-only; a conflict leaves it available for an idempotent retry.
    try{
      const {object,manifest}=await loadManifest(bucket,key,userId);
      if(manifest.generation===current.generation&&manifest.reset?.id===current.reset.id){
        manifest.reset.pending_keys=[];
        await commitManifest(bucket,key,object,manifest);
      }
    }catch{/* A repeat of the same reset_id can safely retry old-object cleanup. */}
  }
  return cleanupComplete;
}
export async function resetUser(bucket,userId,resetId){
  const key=keyFor(userId);
  let current;
  for(let attempt=0;attempt<4;attempt++){
    const {object,manifest}=await loadManifest(bucket,key,userId);
    const {receiptKey,empty}=resetManifestState(manifest,resetId,key);
    if(manifest.reset?.id===resetId||manifest.reset_receipts?.[receiptKey]){current=manifest;break;}
    if(await commitManifest(bucket,key,object,empty)){current=empty;break;}
  }
  if(!current)throw new StorageError('reset_conflict','Concurrent changes detected; pause writes and retry the same reset_id',409);
  // Part cleanup and log cleanup are independent: a failure in one must not
  // skip the other, and repeating the same reset_id retries both.
  const partsCleared=await clearResetPendingKeys(bucket,key,userId,current);
  const logCleared=await clearLog(bucket,key).then(()=>true,()=>false);
  const cleanupComplete=partsCleared&&logCleared;
  return {success:true,user_id:userId,reset_id:resetId,reset_at:current.reset_receipts?.[createHash('sha256').update(resetId).digest('hex')]??current.reset.at,
    cleanup_complete:cleanupComplete,
    message:cleanupComplete?'User memory and Add receipts reset; previous referenced snapshots removed.':'User memory and Add receipts reset; retry the same reset_id to finish snapshot cleanup.'};
}
