import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
const scope = new AsyncLocalStorage();
let sqlite;
let active = false;
export function configure(value) { sqlite = value; }
export function withDatabases(images, operation) {
  if (active) throw Object.assign(new Error('SQLite session is busy; retry'), {status:429,code:'sqlite_busy'});
  active = true;
  return scope.run({ images, opened: new Map() }, async () => {
    try { return await operation(scope.getStore()); }
    finally {
      try { for (const db of scope.getStore().opened.values()) db.close(); }
      finally { active = false; }
    }
  });
}
export class DatabaseSync {
  constructor(path) {
    const state = scope.getStore();
    if (!state || !sqlite) throw new Error('SQLite request context missing');
    if (state.opened.has(path)) return state.opened.get(path);
    this.path = path;
    this.db = new sqlite.oo1.DB(':memory:');
    const image = state.images.get(basename(path));
    if (image) {
      const p = sqlite.capi.sqlite3_malloc64(BigInt(image.byteLength));
      if (!p) throw new Error('SQLite memory allocation failed');
      sqlite.wasm.heap8u().set(image, p);
      const rc = sqlite.capi.sqlite3_deserialize(this.db.pointer, 'main', p,
        BigInt(image.byteLength), BigInt(image.byteLength), 3);
      if (rc) { sqlite.capi.sqlite3_free(p); this.db.close(); throw new Error('SQLite snapshot restore failed: ' + rc); }
    }
    // Bound page growth before export, so one user cannot exhaust the isolate.
    this.db.exec('PRAGMA max_page_count=4096; PRAGMA cache_size=-2048;');
    state.opened.set(path, this);
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    function statement(args, operation) {
      const st = db.prepare(sql);
      try { if (args.length) st.bind(args.map(x => Buffer.isBuffer(x) ? new Uint8Array(x) : x)); return operation(st); }
      finally { st.finalize(); }
    }
    return {
      all(...args) { return statement(args, st => { const rows=[]; while(st.step()) rows.push(st.get({})); return rows; }); },
      get(...args) { return statement(args, st => st.step() ? st.get({}) : undefined); },
      run(...args) { return statement(args, st => { while(st.step()) { /* run() discards row data */ } return { changes: sqlite.capi.sqlite3_changes(db.pointer), lastInsertRowid: sqlite.capi.sqlite3_last_insert_rowid(db.pointer) }; }); }
    };
  }
  close() { if (this.db.pointer) this.db.close(); }
}
