// Types for redact.mjs, the microVM runner's redactor (deploy/aws-microvm/image/runner/): only
// what src/telemetry/local.ts calls.

export function createRedactor(known?: readonly string[]): ((text: string) => string) & { spans(text: string): Array<[number, number]> };
