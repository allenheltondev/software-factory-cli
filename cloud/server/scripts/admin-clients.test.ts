import { afterEach, describe, expect, it } from 'vitest';
import { createAdminClients } from './admin-clients.js';

describe('createAdminClients', () => {
  const saved = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('puts every client in the requested region, whatever the profile or environment says', async () => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    const clients = createAdminClients('us-east-1');
    const regions = await Promise.all(
      [clients.cloudFormation, clients.s3, clients.secrets, clients.ssm, clients.dynamo].map((c) => c.config.region()),
    );
    expect(regions).toEqual(['us-east-1', 'us-east-1', 'us-east-1', 'us-east-1', 'us-east-1']);
  });

  it('leaves the region to the SDK when none is requested', async () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(await createAdminClients(undefined).s3.config.region()).toBe('eu-west-1');
  });
});
