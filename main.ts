// Entry point: start the forge on an ephemeral loopback port, announce it to
// the platform's environment endpoint, and keep serving until the suite says
// it is done. The environment URL is the only external address the process
// ever talks to, and only for its own registration and the done poll.

import { createForge } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const pollIntervalMs = 250;

interface DoneReply {
  done?: unknown;
}

async function postRegistration(port: number): Promise<void> {
  if (envUrl === '') return;
  const res = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
}

async function waitForDone(): Promise<void> {
  if (envUrl === '') {
    // No environment endpoint: stay up until the process is stopped.
    await new Promise(() => undefined);
    return;
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      const res = await fetch(`${envUrl}/done`);
      if (!res.ok) continue;
      const body = (await res.json()) as DoneReply;
      if (body.done === true) return;
    } catch {
      // A transient environment failure is not the forge's failure.
      continue;
    }
  }
}

async function main(): Promise<void> {
  const { server } = createForge();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  await postRegistration(port);
  await waitForDone();
  server.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
