// Loaded only by the root native dispatcher, never by Updraft or the Claude process.
export async function workerControl(config) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const lambda = new LambdaClient({ region: config.region });
  const secrets = new SecretsManagerClient({ region: config.region });
  const token = (await secrets.send(new GetSecretValueCommand({ SecretId: config.controlSecretArn }))).SecretString;
  if (!token || token.length < 32 || token.length > 256) throw new Error('worker control credential unavailable');
  return async (body) => {
    const out = await lambda.send(new InvokeCommand({ FunctionName: config.brokerFunctionName,
      Payload: Buffer.from(JSON.stringify({ ...body, action: 'worker', workerId: config.workerId, token })) }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
    if (out.FunctionError) throw new Error('worker broker unavailable');
    const response = JSON.parse(Buffer.from(out.Payload ?? []).toString('utf8'));
    if (response?.ok !== true) throw new Error('worker broker refused request');
    return response;
  };
}
