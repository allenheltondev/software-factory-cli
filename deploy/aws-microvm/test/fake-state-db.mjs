// A stand-in for an Updraft state database, for tests that have no SQLite to hand: the first
// 100 bytes are a real SQLite header (magic string, user_version at offset 60), which is all
// the runner itself ever reads of the file; the "rows" are a JSON array of strings after it,
// padded to one page. fake-updraft.mjs merges and inspects files of this shape.
const PAGE = 4096;
const MAGIC = 'SQLite format 3\0';

/** @param {string[]} rows @param {number} [schemaVersion] */
export function encodeStateDb(rows, schemaVersion = 3) {
  const json = Buffer.from(JSON.stringify([...new Set(rows)].sort()));
  const buffer = Buffer.alloc(Math.max(PAGE, Math.ceil((100 + 4 + json.length) / PAGE) * PAGE));
  buffer.write(MAGIC, 0, 'latin1');
  buffer.writeUInt16BE(PAGE, 16);
  buffer.writeUInt32BE(schemaVersion, 60);
  buffer.writeUInt32BE(json.length, 100);
  json.copy(buffer, 104);
  return buffer;
}

/** @returns {{ rows: string[], schemaVersion: number }} throws when the bytes are not such a file */
export function decodeStateDb(buffer) {
  if (buffer.length < PAGE || buffer.toString('latin1', 0, MAGIC.length) !== MAGIC) throw new Error('file is not a database');
  const length = buffer.readUInt32BE(100);
  return { rows: JSON.parse(buffer.toString('utf8', 104, 104 + length)), schemaVersion: buffer.readUInt32BE(60) };
}
