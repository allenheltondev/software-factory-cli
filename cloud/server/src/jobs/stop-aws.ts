import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import type { Store } from '../store/store.js';
import { createJobStopper } from './stop.js';

export function awsJobStopper(store: Store, native: Parameters<typeof createJobStopper>[0]['native']) {
  const client = new LambdaMicrovmsClient({ maxAttempts: 2 });
  return createJobStopper({ store, native,
    async terminateMicrovm(id) { await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); },
    async microvmState(id) {
      try { return (await client.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state ?? 'UNKNOWN'; }
      catch (error) { if (error instanceof ResourceNotFoundException) return null; throw error; }
    },
  });
}
