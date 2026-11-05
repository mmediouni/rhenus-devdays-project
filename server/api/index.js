import { loadConfig } from '../src/config.js';
import { createDb, createStorage } from '../src/adapters/index.js';
import { createApp } from '../src/core/app.js';

// Vercel entry point. The same createApp() runs in standalone.js; only the
// wrapper differs. Instances are reused between invocations.
let app;
function getApp() {
  if (!app) {
    const config = loadConfig();
    app = createApp({ db: createDb(config), storage: createStorage(config), config });
  }
  return app;
}

const run = (request) => getApp().handle(request);

export const GET = run;
export const POST = run;
export const PATCH = run;
export const OPTIONS = run;
