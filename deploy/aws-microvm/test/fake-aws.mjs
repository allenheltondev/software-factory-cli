// A stand-in for the `aws` command, for deploy-state.test.mjs: just the calls `deploy.sh
// state unsaved` and `state recover` make, against a directory (FAKE_AWS_ROOT/<bucket>/<key>).
// It checks nothing about real AWS: flags, pagination and error texts are as the script
// expects them, which is what README.md lists under "What is not verified".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = process.env.FAKE_AWS_ROOT;
if (process.env.FAKE_AWS_LOG) fs.appendFileSync(process.env.FAKE_AWS_LOG, `${JSON.stringify(args)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const file = (bucket, key) => path.join(root, bucket, ...key.split('/'));
const etagOf = (body) => `"${crypto.createHash('md5').update(body).digest('hex')}"`;
const fail = (message, code = 254) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const walk = (dir, prefix = '') =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])) : [];

// For deploy-image.test.mjs: the stack's parameters, the launcher's environment, the image's
// versions and what each version's isolation check logs, in a JSON file (FAKE_AWS_STATE) that
// update-stack writes back to.
const stateFile = process.env.FAKE_AWS_STATE;
const state = stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : undefined;
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const text = (value) => process.stdout.write(`${value === undefined || value === null ? 'None' : value}\n`);

const [service, command] = args;
const query = flag('--query') ?? '';
if (state && service === 'cloudformation' && command === 'describe-stacks' && query.includes('Parameters')) {
  const one = /ParameterKey=='([A-Za-z]+)'/.exec(query);
  if (one) text(state.parameters[one[1]]);
  else text(Object.keys(state.parameters).join('\t'));
} else if (state && service === 'cloudformation' && command === 'describe-stack-resource') {
  text('launcher-function');
} else if (state && service === 'cloudformation' && command === 'update-stack') {
  if (!args.includes('--use-previous-template')) fail('fake aws: update-stack without --use-previous-template', 2);
  const given = args.slice(args.indexOf('--parameters') + 1).filter((a) => a.startsWith('ParameterKey='));
  const next = { ...state.parameters };
  for (const p of given) {
    const m = /^ParameterKey=([A-Za-z]+),(?:ParameterValue=(.*)|UsePreviousValue=true)$/.exec(p);
    if (!m) fail(`fake aws: bad parameter ${p}`, 2);
    if (m[2] !== undefined) next[m[1]] = m[2];
  }
  if (given.length !== Object.keys(state.parameters).length) fail('fake aws: update-stack must name every parameter', 2);
  if (JSON.stringify(next) === JSON.stringify(state.parameters)) fail('An error occurred (ValidationError) when calling the UpdateStack operation: No updates are to be performed.');
  state.parameters = next;
  save();
  text('{"StackId": "stack"}');
} else if (state && service === 'cloudformation' && command === 'wait') {
  // stack-update-complete: at once
} else if (state && service === 'lambda' && command === 'get-function-configuration') {
  text(state.launcherEnv[query.replace('Environment.Variables.', '')]);
} else if (state && service === 'lambda-microvms' && command === 'get-microvm-image') {
  text(state.latestActive);
} else if (state && service === 'lambda-microvms' && command === 'get-microvm-image-version') {
  const v = state.versions[flag('--image-version')];
  if (!v) fail('An error occurred (ResourceNotFoundException) when calling the GetMicrovmImageVersion operation: not found');
  text(v);
} else if (state && service === 'lambda-microvms' && command === 'run-microvm') {
  const input = JSON.parse(fs.readFileSync(flag('--cli-input-json').replace(/^file:\/\//, ''), 'utf8'));
  state.runs = [...(state.runs ?? []), input];
  save();
  text('microvm-check-1');
} else if (state && service === 'lambda-microvms' && command === 'get-microvm') {
  text(state.checkState ?? 'RUNNING');
} else if (state && service === 'lambda-microvms' && command === 'terminate-microvm') {
  state.terminated = [...(state.terminated ?? []), flag('--microvm-identifier')];
  save();
} else if (state && service === 'logs' && command === 'get-log-events') {
  const version = flag('--log-stream-name').split('/')[1];
  text(state.checkLines?.[version]);
} else if (service === 'cloudformation' && command === 'describe-stacks') {
  process.stdout.write(`${process.env.FAKE_AWS_BUCKET ?? 'None'}\n`);
} else if (service === 's3api' && command === 'list-objects-v2') {
  const keys = walk(path.join(root, flag('--bucket'))).filter((key) => key.startsWith(flag('--prefix'))).sort();
  process.stdout.write(`${keys.length ? keys.join('\t') : 'None'}\n`);
} else if (service === 's3' && command === 'cp') {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(args[2]);
  if (!m || !fs.existsSync(file(m[1], m[2]))) fail(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${m?.[2]}" does not exist`, 1);
  fs.copyFileSync(file(m[1], m[2]), args[3]);
} else if (service === 's3api' && command === 'get-object') {
  const from = file(flag('--bucket'), flag('--key'));
  if (!fs.existsSync(from)) fail('An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.');
  // The output file is the one positional argument: the one after the key.
  fs.copyFileSync(from, args[args.indexOf('--key') + 2]);
  process.stdout.write(`${etagOf(fs.readFileSync(from))}\n`);
} else if (service === 's3api' && command === 'put-object') {
  const to = file(flag('--bucket'), flag('--key'));
  const current = fs.existsSync(to) ? etagOf(fs.readFileSync(to)) : undefined;
  const ifMatch = flag('--if-match');
  if ((flag('--if-none-match') === '*' && current !== undefined) || (ifMatch !== undefined && ifMatch !== current)) {
    fail('An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold');
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(flag('--body'), to);
  process.stdout.write('{}\n');
} else {
  fail(`fake aws: not implemented: ${args.join(' ')}`, 2);
}
