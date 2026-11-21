import { CreateSecretCommand, DeleteSecretCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SecretsPort } from './agent-keys.js';

/** The Secrets Manager side of an agent key (agent-keys.ts). Never reads a value back. */
export function createSecretsManagerPort(client = new SecretsManagerClient({})): SecretsPort {
  const missing = (err: unknown) => (err as { name?: string }).name === 'ResourceNotFoundException';
  return {
    async put(name, value, tags) {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      } catch (err) {
        if (!missing(err)) throw err;
        try {
          await client.send(new CreateSecretCommand({ Name: name, SecretString: value, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }));
        } catch (e) {
          // Created by a concurrent write between the two calls: this one replaces it.
          if ((e as { name?: string }).name !== 'ResourceExistsException') throw e;
          await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
        }
      }
    },
    async remove(name) {
      try {
        await client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
      } catch (err) {
        if (!missing(err)) throw err;
      }
    },
  };
}
