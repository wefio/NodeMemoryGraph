// Completed vectors only: no Promise, Response, stream, user memory or I/O
// object may escape its originating request. Cache keys include provider scope.
const entries=new Map();
const MAX_BYTES=2*1024*1024,MAX_ENTRIES=128,TTL_MS=10*60*1000;
let bytes=0;
function remove(key){const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key);}}
export function queryVector(key){
  const entry=entries.get(key);if(!entry)return;
  if(entry.expires<=Date.now()){remove(key);return;}
  entries.delete(key);entries.set(key,entry);
  return entry.vectors.map(vector=>vector.slice());
}
export function rememberQueryVector(key,vectors){
  if(vectors.some(vector=>!vector?.length||vector.some(value=>!Number.isFinite(value))))return;
  const size=vectors.reduce((sum,vector)=>sum+vector.length*8,0);
  if(size>MAX_BYTES)return;
  remove(key);
  while(entries.size>=MAX_ENTRIES||bytes+size>MAX_BYTES)remove(entries.keys().next().value);
  entries.set(key,{vectors:vectors.map(vector=>vector.slice()),bytes:size,expires:Date.now()+TTL_MS});
  bytes+=size;
}
