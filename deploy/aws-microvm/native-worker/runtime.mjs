#!/usr/bin/env node
// The docker-shaped runtime used by Updraft. No subscription files or secrets pass here.
import net from 'node:net';
import { DEFAULT_SOCKET, MAX_FRAME, resolveRunEnvironment } from './policy.mjs';
import { frames, send } from './protocol.mjs';

const args = resolveRunEnvironment(process.argv.slice(2), process.env);
const socket = net.createConnection(DEFAULT_SOCKET);
let finished = false;
socket.on('error', () => { process.stderr.write('Native worker unavailable.\n'); process.exitCode = 125; });
socket.on('close', () => { if (!finished) process.exitCode = 125; });
frames(socket, (frame) => {
  if (frame.stream === 'stdout' || frame.stream === 'stderr') process[frame.stream].write(Buffer.from(frame.data, 'base64'));
  else if (Number.isInteger(frame.exitCode)) { finished = true; process.exitCode = frame.exitCode; socket.end(); }
  else socket.destroy();
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { socket.destroy(); process.exitCode = 125; process.stdin.destroy(); });
let prompt = '';
if (args[0] === 'run') {
  for await (const chunk of process.stdin) {
    prompt += chunk.toString('utf8');
    if (Buffer.byteLength(prompt) > MAX_FRAME / 4) { socket.destroy(); throw new Error('prompt exceeds prototype limit'); }
  }
}
if (!socket.destroyed) send(socket, { args, prompt });
