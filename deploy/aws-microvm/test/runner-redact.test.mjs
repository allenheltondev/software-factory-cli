import { describe, expect, it } from 'vitest';
import { MAX_SECRET_BYTES, createRedactor, redactingWriter } from '../image/runner/redact.mjs';

const KEY = 'sk-ant-api03-' + 'k'.repeat(90);
const PLAIN = 'plain-secret-value-0123456789';

/** Everything the writer wrote, and each write on its own. */
function sink() {
  const writes = [];
  return { writes, write: (text) => writes.push(text), all: () => writes.join('') };
}

describe('redactingWriter (#70)', () => {
  it.each([
    ['a key-shaped one', KEY],
    ['one that looks like nothing', PLAIN],
  ])('never writes %s across a long-line flush, wherever the cut would fall', (_what, secret) => {
    const redact = createRedactor([KEY, PLAIN]);
    const flushAt = 4096;
    // The first flush cuts MAX_SECRET_BYTES before the end of what has arrived: put the secret
    // so that cut falls at each offset inside it (no whitespace to cut at instead).
    for (let after = MAX_SECRET_BYTES - secret.length - 2; after <= MAX_SECRET_BYTES + 2; after++) {
      const out = sink();
      const writer = redactingWriter(out.write, redact, flushAt);
      writer.write(`${'x'.repeat(flushAt)}${secret}${'y'.repeat(after)}`);
      writer.write('z'.repeat(flushAt * 2));
      writer.end();
      expect(out.all()).not.toContain(secret);
      for (const w of out.writes) expect(w).not.toContain(secret.slice(0, 12));
      expect(out.all()).toContain('[redacted]');
    }
  });

  it('finds a key split across two writes of one line', () => {
    const out = sink();
    const writer = redactingWriter(out.write, createRedactor([PLAIN]));
    writer.write(`error ${PLAIN.slice(0, 9)}`);
    writer.write(`${PLAIN.slice(9)} done\n`);
    writer.end();
    expect(out.all()).toBe('error [redacted] done\n');
  });
});
