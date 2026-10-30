import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";
const scope = new AsyncLocalStorage();
let sqlite;
let active = false;
/** High-water marks for one instance, exposed to the memory trace: what the largest
 *  simultaneous set of live SQLite images was. A single request holds one partition at a
 *  time, so a reading above that says an image outlived its part. */
const highWater = { databases: 0, imageBytes: 0 };
function noteImage() {
  const store = scope.getStore();
  const databases = store ? store.opened.size : 0;
  const imageBytes = store
    ? [...store.opened.values()].reduce((sum, db) => sum + db.imageBytes, 0)
    : 0;
  highWater.databases = Math.max(highWater.databases, databases);
  highWater.imageBytes = Math.max(highWater.imageBytes, imageBytes);
}
/** Whether this invocation has loaded the SQLite module at all. Reported per request so that
 *  "the deferred load works" is a measurement, not a claim. */
export function sqliteIsReady() {
  return active;
}
/** What the memory trace reports: the live images in this request, the instance high-water
 *  mark, and the WASM linear memory size (which only ever grows). */
export function sqliteStats() {
  const store = scope.getStore();
  const opened = store ? [...store.opened.values()] : [];
  const imageBytes = opened.reduce((sum, db) => sum + db.imageBytes, 0);
  const wasmBytes = (() => {
    try {
      return sqlite ? sqlite.wasm.heap8u().byteLength : null;
    } catch {
      return null;
    }
  })();
  return {
    live_databases: opened.length,
    live_image_mb: Math.round(imageBytes / 10485.76) / 100,
    high_water_databases: highWater.databases,
    high_water_image_mb: Math.round(highWater.imageBytes / 10485.76) / 100,
    wasm_linear_mb: wasmBytes === null ? null : Math.round(wasmBytes / 10485.76) / 100,
  };
}
export function configure(value) {
  sqlite = value;
}
export function withDatabases(images, operation) {
  if (active)
    throw Object.assign(new Error("SQLite session is busy; retry"), {
      status: 429,
      code: "sqlite_busy",
    });
  active = true;
  return scope.run({ images, opened: new Map() }, async () => {
    try {
      return await operation(scope.getStore());
    } finally {
      try {
        for (const db of scope.getStore().opened.values()) db.close();
      } finally {
        active = false;
      }
    }
  });
}
export class DatabaseSync {
  constructor(path) {
    const state = scope.getStore();
    if (!state || !sqlite) throw new Error("SQLite request context missing");
    if (state.opened.has(path)) return state.opened.get(path);
    this.path = path;
    this.db = new sqlite.oo1.DB(":memory:");
    this.imageBytes = 0;
    const image = state.images.get(basename(path));
    if (image) {
      const p = sqlite.capi.sqlite3_malloc64(BigInt(image.byteLength));
      if (!p) throw new Error("SQLite memory allocation failed");
      sqlite.wasm.heap8u().set(image, p);
      const rc = sqlite.capi.sqlite3_deserialize(
        this.db.pointer,
        "main",
        p,
        BigInt(image.byteLength),
        BigInt(image.byteLength),
        3,
      );
      if (rc) {
        sqlite.capi.sqlite3_free(p);
        this.db.close();
        throw new Error("SQLite snapshot restore failed: " + rc);
      }
      this.imageBytes = image.byteLength;
      // The WASM copy owns the bytes now (FREEONCLOSE), so the JS image can be collected
      // while the connection is still open instead of after the whole request.
      state.images.delete(basename(path));
    }
    // Bound page growth before export, so one user cannot exhaust the isolate.
    this.db.exec("PRAGMA max_page_count=4096; PRAGMA cache_size=-2048;");
    state.opened.set(path, this);
    noteImage();
  }
  exec(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    const db = this.db;
    function statement(args, operation) {
      const st = db.prepare(sql);
      try {
        if (args.length) st.bind(args.map((x) => (Buffer.isBuffer(x) ? new Uint8Array(x) : x)));
        return operation(st);
      } finally {
        st.finalize();
      }
    }
    return {
      all(...args) {
        return statement(args, (st) => {
          const rows = [];
          while (st.step()) rows.push(st.get({}));
          return rows;
        });
      },
      get(...args) {
        return statement(args, (st) => (st.step() ? st.get({}) : undefined));
      },
      run(...args) {
        return statement(args, (st) => {
          while (st.step()) {
            /* run() discards row data */
          }
          return {
            changes: sqlite.capi.sqlite3_changes(db.pointer),
            lastInsertRowid: sqlite.capi.sqlite3_last_insert_rowid(db.pointer),
          };
        });
      },
    };
  }
  close() {
    if (this.db.pointer) this.db.close();
  }
}
