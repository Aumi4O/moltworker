/**
 * CDP-only Worker
 *
 * Serves the CDP (Chrome DevTools Protocol) endpoint at moltbot-cdp.<account>.workers.dev.
 * This worker is intentionally NOT behind Cloudflare Access - it uses CDP_SECRET only.
 *
 * Use this URL for OpenClaw browser profiles:
 *   wss://moltbot-cdp.alex-94f.workers.dev/cdp?secret=<CDP_SECRET>
 */
import { Hono } from 'hono';
import type { AppEnv } from './types';
import { cdp } from './routes/cdp';

const app = new Hono<AppEnv>();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'moltbot-cdp', ts: new Date().toISOString() }),
);

app.route('/cdp', cdp);

app.get('/', (c) =>
  c.json({
    service: 'moltbot-cdp',
    description: 'CDP WebSocket endpoint for browser automation',
    endpoints: {
      'GET /health': 'Health check (no auth)',
      'GET /cdp': 'WebSocket upgrade (add ?secret=<CDP_SECRET>)',
      'GET /cdp/json/version': 'Browser version info',
      'GET /cdp/json/list': 'List browser targets',
    },
  }),
);

export default {
  fetch: app.fetch,
};
