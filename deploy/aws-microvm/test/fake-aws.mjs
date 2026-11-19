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

const [service, command] = args;
if (service === 'cloudformation' && command === 'describe-stacks') {
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
