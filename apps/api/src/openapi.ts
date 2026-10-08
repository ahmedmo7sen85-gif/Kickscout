import { openApiDocument } from './app.js';

process.stdout.write(`${JSON.stringify(openApiDocument(), null, 2)}\n`);
