// Bounded page overlays stored atomically in the existing manifest. A base
// snapshot never changes while it has an overlay; no replay queue is required.
export const PART_DELTA_LIMIT = 256 * 1024;
export const USER_DELTA_LIMIT = 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
export function deltaBytes(part) {
  return part.delta ? Object.keys(part.delta.pages).length * part.delta.page_size : 0;
}
function pageSize(image) {
  if(image.length<100||Buffer.from(image.subarray(0,16)).toString()!=='SQLite format 3\0')return 0;
  const value=(image[16]<<8)|image[17];return value===1?65536:value;
}
export function applyPageDelta(base, part, inPlace=false) {
  if(!part.delta)return base;
  const {page_size:size,pages,format}=part.delta;
  if(format!=='sqlite-pages-v1'||!Number.isInteger(size)||size<512||size>65536||(size&(size-1))||pageSize(base)!==size||
    !Number.isInteger(part.bytes)||part.bytes<100||part.bytes>MAX_IMAGE||part.bytes%size||
    !pages||typeof pages!=='object'||Array.isArray(pages)||deltaBytes(part)>PART_DELTA_LIMIT)
    throw new Error('Invalid SQLite page overlay');
  const image=inPlace&&base.length===part.bytes?base:new Uint8Array(part.bytes);
  if(image!==base)image.set(base.subarray(0,Math.min(base.length,image.length)));
  for(const [key,encoded] of Object.entries(pages)){
    const page=Number(key);
    if(!/^(0|[1-9]\d*)$/.test(key)||!Number.isSafeInteger(page)||page*size>=image.length||typeof encoded!=='string'||encoded.length!==4*Math.ceil(size/3))
      throw new Error('Invalid SQLite page overlay entry');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length!==size)throw new Error('Invalid SQLite page overlay payload');
    image.set(bytes,page*size);
  }
  if(pageSize(image)!==size)throw new Error('SQLite overlay page size changed');
  return image;
}
export function makePageDelta(part, before, after, userBudget) {
  const size=pageSize(after);
  if(!before||!part.key||!size||pageSize(before)!==size||after.length%size||after.length>MAX_IMAGE)return null;
  const pages={...part.delta?.pages};
  for(const key of Object.keys(pages))if(Number(key)*size>=after.length)delete pages[key];
  let changed=before.length!==after.length, changedPages=0;
  // Stop before encoding an unbounded patch. Ordinary queries touch a small
  // fraction of the snapshot; larger changes fall back to one full snapshot.
  const limit=Math.min(PART_DELTA_LIMIT,userBudget);
  let bytes=Object.keys(pages).length*size;
  const old=Buffer.from(before.buffer,before.byteOffset,before.byteLength);
  const fresh=Buffer.from(after.buffer,after.byteOffset,after.byteLength);
  for(let offset=0;offset<after.length;offset+=size){
    if(offset+size<=before.length&&fresh.subarray(offset,offset+size).equals(old.subarray(offset,offset+size)))continue;
    const key=String(offset/size);
    changed=true;changedPages++;
    if(!(key in pages))bytes+=size;
    if(bytes>limit)return null;
    pages[key]=fresh.subarray(offset,offset+size).toString('base64');
  }
  if(bytes>limit)return null;
  return {part:{...part,bytes:after.length,delta:{format:'sqlite-pages-v1',page_size:size,pages}},changed,changedPages,inlineBytes:bytes};
}
