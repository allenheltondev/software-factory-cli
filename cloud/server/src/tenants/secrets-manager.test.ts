import { describe, expect, it } from 'vitest';
import { createSecretsManagerPort } from './secrets-manager.js';

describe('the Secrets Manager port', () => {
  it('says which version it wrote, replacing a secret or creating one', async () => {
    const sent: string[] = [];
    let exists = true;
    const client = {
      send: async (cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        sent.push(name);
        if (name === 'PutSecretValueCommand') {
          if (!exists) throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
          return { VersionId: 'v-put' };
        }
        if (name === 'CreateSecretCommand') {
          exists = true;
          return { VersionId: 'v-create' };
        }
        return {};
      },
    };
    const port = createSecretsManagerPort(client as never);
    expect(await port.put('s', 'value', {})).toEqual({ versionId: 'v-put' });
    exists = false;
    expect(await port.put('s', 'value', { a: 'b' })).toEqual({ versionId: 'v-create' });
    expect(sent).toEqual(['PutSecretValueCommand', 'PutSecretValueCommand', 'CreateSecretCommand']);
  });
});
