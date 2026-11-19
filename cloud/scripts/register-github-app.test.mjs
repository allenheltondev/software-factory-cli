import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifest, startPage } from './register-github-app.mjs';

test('the manifest points GitHub at this deployment', () => {
  const m = manifest({ appUrl: 'https://updraft.example/', name: 'Updraft', port: 3999 });
  assert.equal(m.hook_attributes.url, 'https://updraft.example/api/webhooks/github');
  assert.deepEqual(m.callback_urls, ['https://updraft.example/github/callback']);
  assert.equal(m.redirect_url, 'http://127.0.0.1:3999/done');
  assert.equal(m.request_oauth_on_install, true);
  assert.equal(m.default_permissions.members, 'read');
  assert.equal(m.default_permissions.contents, 'write');
  assert.ok(!('administration' in m.default_permissions));
  assert.deepEqual(m.default_events, ['issues', 'pull_request', 'pull_request_review']);
});

test('the start page posts the manifest to the user or org settings page, escaped', () => {
  const json = JSON.stringify({ name: 'a"<b>' });
  const user = startPage({ manifestJson: json, state: 'st' });
  assert.match(user, /action="https:\/\/github\.com\/settings\/apps\/new\?state=st"/);
  assert.ok(!user.includes('a"<b>'));
  const org = startPage({ manifestJson: json, org: 'acme', state: 'st' });
  assert.match(org, /organizations\/acme\/settings\/apps\/new/);
});
