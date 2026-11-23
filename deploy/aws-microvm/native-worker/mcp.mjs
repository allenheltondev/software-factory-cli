// Trusted stdio MCP client shim. It never reads the repo or the auth store.
import net from 'node:net';
import { frames, send } from './protocol.mjs';

const socket = net.createConnection(process.argv[2]);
socket.on('error', () => process.exit(1));
frames(socket, (reply) => send(process.stdout, reply));
frames(process.stdin, (request) => send(socket, request), () => process.exit(1));
process.stdin.on('end', () => socket.end());
socket.on('close', () => process.exit(0));
