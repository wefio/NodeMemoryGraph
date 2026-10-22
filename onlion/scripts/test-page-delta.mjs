/* eslint-disable no-console -- deliberate test/diagnostic output */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {applyPageDelta,makePageDelta,PART_DELTA_LIMIT} from '../backend/page-delta.mjs';
const fixture=spawnSync('python3',['-c',`
import sqlite3,base64,json
c=sqlite3.connect(':memory:');c.execute('PRAGMA page_size=4096')
c.execute('create table records(id integer primary key, count integer, text text)')
c.executemany('insert into records values(?,?,?)',[(i,0,'robot '+str(i)) for i in range(1000)])
def image():
 c.commit();return base64.b64encode(c.serialize()).decode()
base=image()
c.execute('update records set count=count+1 where id<20');first=image()
c.execute('update records set count=count+1 where id between 10 and 30');second=image()
c.executemany('insert into records values(?,?,?)',[(i,0,'x'*1000) for i in range(1000,2000)]);grown=image()
c.execute('delete from records where id>=500');c.commit();c.execute('vacuum');shrunk=image()
print(json.dumps(dict(base=base,first=first,second=second,grown=grown,shrunk=shrunk)))
`],{maxBuffer:8*1024*1024});
assert.equal(fixture.status,0,fixture.stderr.toString());
const states=Object.fromEntries(Object.entries(JSON.parse(fixture.stdout)).map(([k,v])=>[k,Buffer.from(v,'base64')]));
const part={scope:'test',key:'base.sqlite',bytes:states.base.length};
const first=makePageDelta(part,states.base,states.first,PART_DELTA_LIMIT);
assert.ok(first&&first.changed);assert.deepEqual(Buffer.from(applyPageDelta(states.base,first.part)),states.first);
const second=makePageDelta(first.part,states.first,states.second,PART_DELTA_LIMIT);
assert.ok(second&&second.changed);assert.deepEqual(Buffer.from(applyPageDelta(states.base,second.part)),states.second);
assert.equal(makePageDelta(second.part,states.second,states.second,PART_DELTA_LIMIT).changed,false);
assert.equal(makePageDelta(part,states.base,states.first,0),null);
assert.equal(makePageDelta(second.part,states.second,states.grown,PART_DELTA_LIMIT),null);
const shrink=makePageDelta(second.part,states.second,states.shrunk,PART_DELTA_LIMIT);
assert.ok(shrink);assert.deepEqual(Buffer.from(applyPageDelta(states.base,shrink.part)),states.shrunk);
assert.throws(()=>applyPageDelta(states.base,{...first.part,delta:{...first.part.delta,pages:{0:'bad'}}}));
console.log('PASS: real SQLite images reconstruct byte-for-byte; accumulated updates, shrink, no-op, invalid payload and bounded fallback.');
