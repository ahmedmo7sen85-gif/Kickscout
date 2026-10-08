import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from './server.js';

// One app per function instance, reused across invocations. A small pool: Vercel runs many
// instances, and DATABASE_URL should point at a transaction-mode pooler.
const ready = createServer({ poolSize: 3 }).then(async ({ app }) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
