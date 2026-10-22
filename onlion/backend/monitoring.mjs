import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
const requests=new AsyncLocalStorage(),stages=new WeakMap();
const ERROR_KEY='monitoring/recent-failures.json',MAX_ERRORS=20,RETENTION_MS=86400000;
const localFailures=[];
let waiting=0,backlogSince=null,lastEmbedding=null;
const running=new Map();
export const withRequest=(context,operation)=>requests.run(context,operation);
export function requestIdentity(userId,requestId){
  const context=requests.getStore();if(!context)return;
  for(const [name,value] of Object.entries({user_id:userId,request_id:requestId})){
    if(typeof value==='string')context[name+'_hash']=createHash('sha256').update(value).digest('hex').slice(0,24);
  }
}
export function observedStage(name,operation){
  try{
    const result=operation();
    if(result&&typeof result.then==='function')return result.catch(error=>{if(error&&typeof error==='object'&&!stages.has(error))stages.set(error,name);throw error;});
    return result;
  }catch(error){if(error&&typeof error==='object'&&!stages.has(error))stages.set(error,name);throw error;}
}
export function queueAccepted(){if(waiting++===0)backlogSince=Date.now();}
export function queueStarted(context){waiting--;if(waiting===0)backlogSince=null;running.set(context.trace_id,{trace_id:context.trace_id,route:context.route,started_at:Date.now()});}
export function queueFinished(){const context=requests.getStore();if(context)running.delete(context.trace_id);}
export function queueStatus(){
  const now=Date.now(),active=running.values().next().value;return {scope:'current_isolate',waiting,running:running.size,
    backlog_ms:backlogSince===null?0:now-backlogSince,
    active:active?{...active,elapsed_ms:now-active.started_at}:null};
}
export function classifyError(error){
  const message=String(error?.message??'');
  const upstream=/embedding server returned\s+(\d{3})/i.exec(message);
  const sqlite=/SQLITE_[A-Z_]+/.exec(message)?.[0];
  let code=typeof error?.code==='string'&&/^[a-zA-Z0-9_]{1,64}$/.test(error.code)?error.code:null;
  code??=upstream?'embedding_http_'+upstream[1]:sqlite==='SQLITE_FULL'?'user_storage_limit':sqlite?'sqlite_error':error?.name==='TimeoutError'?'dependency_timeout':error?.name==='AbortError'?'operation_aborted':'service_unavailable';
  const summaries={user_storage_limit:'数据库容量或工作分片已达上限',part_storage_limit:'本批数据超过分片限制',request_receipt_limit:'写入回执数量已达上限',write_conflict:'并发提交冲突，重试次数已用完',snapshot_changed:'读取的快照已被替换',storage_unavailable:'持久存储不可用',storage_corrupt:'存储格式异常',not_configured:'服务鉴权未配置',reclamation_in_progress:'正在完全回收，记忆存取暂停',memory_reclaimed:'回收期间的旧请求已停止',user_reset:'用户数据已被重置',sqlite_error:'SQLite 执行失败',dependency_timeout:'外部依赖超时',operation_aborted:'操作被中止',embedding_timeout:'远程向量模型超时',embedding_network_error:'远程向量模型连接失败',embedding_failed:'远程向量模型调用失败',service_unavailable:'服务处理失败，需要凭关联编号查询平台日志'};
  const summary=upstream?'远程向量模型返回 HTTP '+upstream[1]:(summaries[code]??'服务操作失败：'+code);
  return {code,summary,...(upstream?{upstream_status:Number(upstream[1])}:{}),...(sqlite?{sqlite_code:sqlite}:{})};
}
async function persistFailure(bucket,entry){
  for(let attempt=0;attempt<2;attempt++){
    const old=await bucket.get(ERROR_KEY);
    const previous=old?await old.json():[];
    const entries=[entry,...previous.filter(e=>e.id!==entry.id&&Date.now()-Date.parse(e.at)<RETENTION_MS)].slice(0,MAX_ERRORS);
    const saved=await bucket.put(ERROR_KEY,JSON.stringify(entries),{onlyIf:old?{etagMatches:old.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
    if(saved)return;
  }
}
export function reportFailure(error,status,kind='request_failure'){
  const context=requests.getStore();if(!context)return;
  const entry={id:crypto.randomUUID(),at:new Date().toISOString(),kind,status,
    trace_id:context.trace_id,route:context.route,stage:stages.get(error)??'handler',
    ...classifyError(error),...(context.user_id_hash?{user_id_hash:context.user_id_hash}:{}),
    ...(context.request_id_hash?{request_id_hash:context.request_id_hash}:{})};
  localFailures.unshift(entry);localFailures.length=Math.min(localFailures.length,MAX_ERRORS);
  // No exception text, stack, request body, source statements or credentials.
  console.error(JSON.stringify({event:'nmg_failure',...entry}));
  if(context.env.MEMORY&&context.execution?.waitUntil){
    context.execution.waitUntil(persistFailure(context.env.MEMORY,entry).catch(()=>console.error(JSON.stringify({event:'nmg_monitor_persistence_failed',trace_id:entry.trace_id}))));
  }
}
export async function embeddingOperation(operation){
  try{const value=await observedStage('embedding',operation);lastEmbedding={status:'ok',at:new Date().toISOString()};return value;}
  catch(caught){
    const error=caught&&typeof caught==='object'?caught:new Error('Embedding failed');
    if(!error.code){error.code=/embedding server returned/.test(String(error.message))?classifyError(error).code:error.name==='TimeoutError'?'embedding_timeout':error.name==='TypeError'?'embedding_network_error':'embedding_failed';}
    lastEmbedding={status:'failed',at:new Date().toISOString(),...classifyError(error)};
    reportFailure(error,null,'embedding_failure');throw error;
  }
}
export async function recentFailures(bucket){
  const object=await bucket.get(ERROR_KEY);
  const persisted=object?await object.json():[];
  return [...new Map([...localFailures,...persisted].filter(e=>Date.now()-Date.parse(e.at)<RETENTION_MS).map(e=>[e.id,e])).values()]
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,MAX_ERRORS);
}
export const embeddingObservation=()=>lastEmbedding;
export async function check(operation,timeoutMs=3000){
  let timer;const start=performance.now();
  try{const value=await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Probe timeout'),{code:'probe_timeout'})),timeoutMs);})]);return {status:'ok',ms:performance.now()-start,value};}
  catch(error){return {status:'failed',ms:performance.now()-start,code:error.code==='probe_timeout'?'probe_timeout':classifyError(error).code};}
  finally{clearTimeout(timer);}
}
