import { MAX_FRAME } from './policy.mjs';

export function send(stream, frame) {
  if (stream.writableLength > MAX_FRAME) { stream.destroy(); return; }
  if (!stream.destroyed && stream.writable) stream.write(`${JSON.stringify(frame)}\n`);
}

// Byte-bounded NDJSON. No unbounded readline buffers on a local privileged socket.
export function frames(stream, receive, fail = () => stream.destroy()) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      if (end > MAX_FRAME) { fail(); return; }
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try { receive(JSON.parse(line.toString('utf8'))); } catch { fail(); return; }
    }
    if (buffer.length > MAX_FRAME) fail();
  });
}
