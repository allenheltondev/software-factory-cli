import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import type { Store } from '../store/store.js';
import { createJobStopper } from './stop.js';

export function awsJobStopper(store: Store, native: Parameters<typeof createJobStopper>[0]['native'], workflows?: Parameters<typeof createJobStopper>[0]['workflows']) {
  const client = new LambdaMicrovmsClient({ maxAttempts: 2 });
  return createJobStopper({ store, native, workflows,
    async terminateMicrovm(id) {
      try { await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })); }
      catch (error) { if (!(error instanceof ResourceNotFoundException)) throw error; }
    },
    async microvmState(id) {
      try { return (await client.send(new GetMicrovmCommand({ microvmIdentifier: id }))).state ?? 'UNKNOWN'; }
      catch (error) { if (error instanceof ResourceNotFoundException) return null; throw error; }
    },
  });
}
