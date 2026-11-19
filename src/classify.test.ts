import { describe, expect, it } from 'vitest';
import { classifyIssue } from './classify.js';

const c = (title: string, body = '', labels: string[] = []) => classifyIssue({ title, body, labels });

describe('classifyIssue', () => {
  it('typos and docs are routine', () => {
    expect(c('Fix typo in README')).toMatchObject({ complexity: 'routine', risk: 'low' });
  });
  it('isolated tests are routine', () => {
    expect(c('Add a unit test for parser')).toMatchObject({ complexity: 'routine' });
  });
  it('ordinary work is standard with low confidence', () => {
    const r = c('Add a retry option to export', 'please');
    expect(r.complexity).toBe('standard');
    expect(r.confidence).toBeLessThan(0.6);
  });
  it('migrations and concurrency are complex, medium risk', () => {
    expect(c('Database migration for lifecycle events')).toMatchObject({ complexity: 'complex', risk: 'medium' });
  });
  it('auth/secrets/permissions/data loss are high risk regardless of complexity', () => {
    for (const t of ['Fix auth bug', 'Rotate secrets', 'Permission check', 'Possible data loss on sync']) {
      expect(c(t).risk).toBe('high');
    }
    expect(c('Fix typo in the auth docs')).toMatchObject({ complexity: 'routine', risk: 'high' });
  });
  it('labels contribute', () => {
    expect(c('x', '', ['security']).risk).toBe('high');
    expect(c('x', '', ['documentation']).complexity).toBe('routine');
  });
  it('conflicting routine and complex signals are low confidence standard', () => {
    const r = c('Fix typo while we redesign the architecture');
    expect(r.complexity).toBe('standard');
    expect(r.confidence).toBeLessThan(0.6);
  });
  it('long bodies are not routine', () => {
    expect(c('Fix typo', 'x'.repeat(2000)).complexity).toBe('standard');
  });
  it('is deterministic and explains itself', () => {
    expect(c('Fix typo')).toEqual(c('Fix typo'));
    expect(c('Fix typo').reasons.length).toBeGreaterThan(0);
  });
});
