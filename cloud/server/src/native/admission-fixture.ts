import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Admission tests use the actual CAS implementation against a strongly consistent in-memory item. */
export function admissionFixture() {
  let item: Record<string, unknown> | undefined;
  const send = async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: item ? structuredClone(item) : undefined };
    if (command instanceof PutCommand) {
      const input = command.input;
      if (
        input.ConditionExpression === 'attribute_not_exists(pk)'
          ? !!item
          : item?.revision !== input.ExpressionAttributeValues?.[':revision']
      ) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'CAS lost' });
      }
      item = structuredClone(input.Item);
      return {};
    }
    throw new Error('Unexpected admission database command');
  };
  return { db: { send } as unknown as DynamoDBDocumentClient, read: () => item };
}
