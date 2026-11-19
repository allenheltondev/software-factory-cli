import { describe, expect, it } from 'vitest';
import { classifyCliFailure } from './usage-limit.js';

const NOW = Date.parse('2026-11-18T10:00:00Z');

describe('classifyCliFailure', () => {
  it('recognizes a Codex usage limit and its stated wait', () => {
    const f = classifyCliFailure('codex', "Reading additional input from stdin...\nERROR: You've hit your usage limit. Try again in 2 hours 30 minutes.", NOW);
    expect(f.kind).toBe('usage-limit');
    expect(f.retryAfterMs).toBe(150 * 60_000);
  });

  it("recognizes Claude's limit line and the legacy epoch form", () => {
    const epoch = Math.floor((NOW + 90 * 60_000) / 1000);
    const f = classifyCliFailure('claude', `Claude AI usage limit reached|${epoch}`, NOW);
    expect(f).toMatchObject({ kind: 'usage-limit', retryAfterMs: 90 * 60_000 });
    expect(classifyCliFailure('claude', '{"type":"result","is_error":true,"result":"5-hour limit reached"}', NOW).kind).toBe('usage-limit');
  });

  it('gives no retry-after when the CLI did not state a reliable one', () => {
    const f = classifyCliFailure('claude', "You've hit your limit · resets 3pm", NOW);
    expect(f.kind).toBe('usage-limit');
    expect(f.retryAfterMs).toBeUndefined();
  });

  it('honors a Retry-After header', () => {
    expect(classifyCliFailure('kiro', 'Error: 429 Too Many Requests\nretry-after: 120', NOW)).toMatchObject({ kind: 'usage-limit', retryAfterMs: 120_000 });
  });

  it('does not treat authentication failures as quota exhaustion', () => {
    expect(classifyCliFailure('claude', 'Not logged in · Please run /login', NOW).kind).toBe('auth');
    expect(classifyCliFailure('codex', 'ERROR: 401 Unauthorized: invalid API key', NOW).kind).toBe('auth');
  });

  it('leaves generic failures alone', () => {
    expect(classifyCliFailure('codex', 'error: tests failed\nexit 1', NOW).kind).toBe('other');
    expect(classifyCliFailure('claude', 'the build was throttled at port 4290', NOW).kind).toBe('other');
    expect(classifyCliFailure('claude', '', NOW).kind).toBe('other');
  });
});
