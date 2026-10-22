import {createHash} from 'node:crypto';
import {StorageError} from './storage.mjs';

const CONTROL='maintenance/memory-reclamation.json';
const SCOPED=Symbol('nmg-memory-generation');
const ROOTS=['users/','generations/'];
const fingerprint=id=>createHash('sha256').update(id).digest('hex');
const prefixFor=epoch=>epoch?`generations/${epoch}/`:'';
async function control(bucket){
  const object=await bucket.get(CONTROL);
  return {object,state:object?await object.json():{epoch:null,active:null,completed:{}}};
}
async function save(bucket,object,state){
  return bucket.put(CONTROL,JSON.stringify(state),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
}
function view(state,id){
  const done=id?state.completed?.[fingerprint(id)]:null;
  if(done)return {success:true,scope:'all_memory',operation_id:id,complete:true,...done};
  return {success:true,scope:'all_memory',complete:!state.active,maintenance:!!state.active,...(state.active??{})};
}
export async function reclamationStatus(bucket){return view((await control(bucket)).state);}

// Bind each request to one storage generation. Normal requests read only this
// small control record; bucket enumeration happens exclusively during reclaim.
export async function memoryBucket(bucket){
  if(bucket[SCOPED])return bucket;
  const {state}=await control(bucket);
  if(state.active)throw new StorageError('reclamation_in_progress','Full memory reclamation is paused or running; resume the same operation before using memory',503);
  const epoch=state.epoch,prefix=prefixFor(epoch);
  const scoped=key=>prefix+key;
  async function assertGeneration(){
    const latest=(await control(bucket)).state;
    if(latest.epoch!==epoch||latest.active)throw new StorageError('memory_reclaimed','Memory was fully reclaimed during this request; restart with the new dataset',409);
  }
  return {
    [SCOPED]:true,
    get:(key,options)=>bucket.get(scoped(key),options),
    head:key=>bucket.head(scoped(key)),
    async put(key,value,options){
      const result=await bucket.put(scoped(key),value,options);
      try{await assertGeneration();}
      catch(error){
        // Clean late writes to an obsolete generation; never delete a live
        // object merely because the control-record read had a transient error.
        if(result&&error.code==='memory_reclaimed')await bucket.delete(scoped(key)).catch(()=>{});
        throw error;
      }
      return result;
    },
    delete:keys=>bucket.delete(Array.isArray(keys)?keys.map(scoped):scoped(keys)),
  };
}

// A caller repeats this bounded operation until complete=true. New requests are
// fenced first, then old generation objects (including orphans) are swept twice.
// Application assets, secrets and non-memory bucket keys are outside ROOTS.
export async function reclaimAll(bucket,id){
  let {object,state}=await control(bucket);
  if(state.completed?.[fingerprint(id)])return view(state,id);
  if(state.active&&state.active.operation_id!==id)throw new StorageError('reclamation_conflict','Another full reclamation is active; resume its operation_id',409);
  if(!state.active){
    state={...state,epoch:crypto.randomUUID(),active:{operation_id:id,started_at:new Date().toISOString(),pass:0,root_index:0,cursor:null,removed_objects:0,removed_bytes:0}};
    if(!await save(bucket,object,state))throw new StorageError('reclamation_conflict','Concurrent reclamation change; retry the same operation_id',409);
  }
  // Four pages per call bound request duration and memory even for a full bucket.
  for(let page=0;page<4;page++){
    ({object,state}=await control(bucket));
    if(state.completed?.[fingerprint(id)])return view(state,id);
    if(state.active?.operation_id!==id)throw new StorageError('reclamation_conflict','Reclamation ownership changed',409);
    const job=state.active,epoch=state.epoch;
    const result=await bucket.list({prefix:ROOTS[job.root_index],limit:256,...(job.cursor?{cursor:job.cursor}:{})});
    const keep=prefixFor(epoch);
    const obsolete=result.objects.filter(o=>!keep||!o.key.startsWith(keep));
    const latest=(await control(bucket)).state;
    if(latest.epoch!==epoch||latest.active?.operation_id!==id)throw new StorageError('reclamation_conflict','Reclamation generation changed; retry the same operation_id',409);
    if(obsolete.length)await bucket.delete(obsolete.map(o=>o.key));
    job.removed_objects+=obsolete.length;
    job.removed_bytes+=obsolete.reduce((sum,o)=>sum+o.size,0);
    if(result.truncated){job.cursor=result.cursor;}
    else{
      job.cursor=null;job.root_index++;
      if(job.root_index===ROOTS.length){job.root_index=0;job.pass++;}
    }
    if(job.pass===2){
      const receipt={finished_at:new Date().toISOString(),removed_objects:job.removed_objects,removed_bytes:job.removed_bytes};
      state={...state,active:null,completed:{...state.completed,[fingerprint(id)]:receipt}};
    }
    // Concurrent calls with this same ID may repeat a page, but cannot advance
    // stale progress or erase a later generation. Failed calls can be resumed.
    if(!await save(bucket,object,state))return view((await control(bucket)).state,id);
    if(!state.active)return view(state,id);
  }
  return view(state,id);
}
