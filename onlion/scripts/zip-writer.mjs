/**
 * Minimal, dependency-free ZIP writer.
 *
 * Why not shell out: git-bash ships GNU tar, which ignores `tar -a` and happily
 * writes a plain TAR named `.zip` (the console then rejects it with "not a valid
 * ZIP"). PowerShell's Compress-Archive treats `[` in file names as a wildcard,
 * and our function entry is `[[default]].js`. So the bytes are written here:
 * deflate + a standard central directory, no data descriptors, no Zip64.
 */
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what the ZIP format stores. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.dos.time, 10);
  header.writeUInt16LE(entry.dos.day, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.payload.length, 18);
  header.writeUInt32LE(entry.raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(entry, offset) {
  const name = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dos.time, 12);
  header.writeUInt16LE(entry.dos.day, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.payload.length, 20);
  header.writeUInt32LE(entry.raw.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attrs
  header.writeUInt32LE(entry.name.endsWith("/") ? 0x41ed0000 : 0o100644 * 0x10000, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/** Collects files (and directories) under `root`, prefixed with `prefix`. */
export function collectEntries(root, prefix = "") {
  const entries = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = `${prefix}${path.relative(root, absolute).split(path.sep).join("/")}`;
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) {
        entries.push({ name: `${relative}/`, data: Buffer.alloc(0), mtime: stat.mtime });
        walk(absolute);
      } else {
        entries.push({ name: relative, data: fs.readFileSync(absolute), mtime: stat.mtime });
      }
    }
  };
  walk(root);
  return entries;
}

/** Writes `entries` ([{name, data, mtime}]) as a ZIP archive at `zipPath`. */
export function writeZip(zipPath, entries) {
  const prepared = entries.map((entry) => {
    const compressed = entry.data.length ? deflateRawSync(entry.data, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = compressed.length > 0 && compressed.length < entry.data.length;
    return {
      name: entry.name,
      raw: entry.data,
      method: useDeflate ? 8 : 0,
      payload: useDeflate ? compressed : entry.data,
      crc: crc32(entry.data),
      dos: dosDateTime(entry.mtime ?? new Date()),
    };
  });

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of prepared) {
    const header = localHeader(entry);
    chunks.push(header, entry.payload);
    central.push(centralHeader(entry, offset));
    offset += header.length + entry.payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, directory, end]));
  return { entries: prepared.length, bytes: offset + directory.length + end.length };
}
