import { Hono } from 'hono';
import type { AppEnv } from '../types';

/**
 * Admin UI routes — SPA only: device pairing, gateway restart, CDP URL patch.
 * Do not add R2 / manual backup / restore UI here; persistence is in-container (rclone).
 *
 * Static assets (/_admin/assets/*) are handled by publicRoutes.
 * Auth is applied centrally in index.ts before this app is mounted.
 */
const adminUi = new Hono<AppEnv>();

// Serve index.html for all admin routes (SPA)
adminUi.get('*', async (c) => {
  const url = new URL(c.req.url);
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString()));
});

export { adminUi };
