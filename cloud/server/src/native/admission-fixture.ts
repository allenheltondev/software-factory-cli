import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type Session = { generation: string; retiring?: boolean };
/** Actual registry writes and session conditions are validated atomically by this in-memory client. */
export function admissionFixture(
  initial?: Record<string, unknown>,
  /** The session a check names: `sk` is the record (`CLAUDE_SESSION`, or `CODEX_SESSION`). */
  lookupSession?: (id: number, sk: string) => Session | undefined,
  beforeCommit?: () => void,
) {
  let item: Record<string, unknown> | undefined = initial ? structuredClone(initial) : undefined;
  const matches = (condition?: string, values?: Record<string, unknown>) => {
    if (condition === 'attribute_not_exists(pk)') return !item;
    if (condition === 'revision = :revision') return item?.revision === values?.[':revision'];
    throw Error('Unexpected registry condition');
  };
  const send = async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: item ? structuredClone(item) : undefined };
    if (command instanceof PutCommand) {
      if (!matches(command.input.ConditionExpression, command.input.ExpressionAttributeValues))
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'CAS lost' });
      item = structuredClone(command.input.Item);
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      beforeCommit?.();
      const put = command.input.TransactItems?.[0]?.Put;
      const check = command.input.TransactItems?.[1]?.ConditionCheck;
      if (!put || !check || command.input.TransactItems?.length !== 2 || !['CLAUDE_SESSION', 'CODEX_SESSION'].includes(String(check.Key?.sk)))
        throw Error('Unexpected admission transaction');
      const id = Number(String(check.Key!.pk).replace(/^TENANT#/, ''));
      if (!Number.isSafeInteger(id) || id <= 0) throw Error('Unexpected session partition');
      const session = lookupSession?.(id, String(check.Key!.sk));
      const generation = check.ExpressionAttributeValues?.[':generation'];
      const expr = check.ConditionExpression;
      let allowed: boolean;
      if (expr === 'generation = :generation AND attribute_not_exists(retiring)')
        allowed =
          !!session && session.generation === generation && !Object.prototype.hasOwnProperty.call(session, 'retiring');
      else if (expr === 'generation = :generation AND retiring = :retiring')
        allowed = session?.generation === generation && session?.retiring === true;
      else if (expr === 'attribute_not_exists(pk) OR generation <> :generation OR retiring = :retiring')
        allowed = !session || session.generation !== generation || session.retiring === true;
      else throw Error('Unexpected generation condition');
      // Pure accounting suites model every supplied generation as eligible. Lifecycle suites
      // supply the actual changing session lookup and exercise all generation predicates.
      const registryMatches = matches(put.ConditionExpression, put.ExpressionAttributeValues);
      if (!registryMatches || (lookupSession && !allowed))
        throw new TransactionCanceledException({
          $metadata: {},
          message: 'CAS/session check lost',
          CancellationReasons: [
            { Code: registryMatches ? 'None' : 'ConditionalCheckFailed' },
            { Code: !lookupSession || allowed ? 'None' : 'ConditionalCheckFailed' },
          ],
        });
      item = structuredClone(put.Item);
      return {};
    }
    throw Error('Unexpected admission database command');
  };
  return {
    db: { send } as unknown as DynamoDBDocumentClient,
    read: () => item,
    replace: (next: Record<string, unknown>) => {
      item = structuredClone(next);
    },
  };
}
