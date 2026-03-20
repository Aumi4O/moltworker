import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/startup-logs - Fetch gateway process logs (auth: ?token=MOLTBOT_GATEWAY_TOKEN)
// Use this to diagnose gateway crashes without Cloudflare Access login
// Tries: 1) R2-persisted startup.log (survives container disconnect), 2) process logs
publicRoutes.get('/api/startup-logs', async (c) => {
  const token = c.req.query('token');
  const expectedToken = c.env.MOLTBOT_GATEWAY_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return c.json({ error: 'Invalid or missing token', hint: 'Add ?token=YOUR_GATEWAY_TOKEN' }, 401);
  }
  const sandbox = c.get('sandbox');
  try {
    // First try R2-persisted log (survives container disconnect after crash)
    try {
      const catProc = await sandbox.startProcess('cat /data/moltbot/startup.log 2>/dev/null || true');
      await new Promise((r) => setTimeout(r, 2000));
      const catLogs = await catProc.getLogs?.();
      const r2Log = (catLogs?.stdout || '').trim();
      if (r2Log.length > 0) {
        return c.json({
          status: 'ok',
          source: 'r2_persisted',
          combined: r2Log.slice(-8000),
          stdout: r2Log,
          stderr: '',
        });
      }
    } catch {
      // R2 read failed, fall through to process logs
    }

    // Fallback: get logs from gateway process
    const procs = await sandbox.listProcesses();
    const gatewayProcs = procs.filter(
      (p) =>
        (p.command.includes('start-openclaw.sh') || p.command.includes('openclaw gateway')) &&
        !p.command.includes('openclaw devices'),
    );
    const proc = gatewayProcs.sort((a, b) => (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0))[0];
    if (!proc) {
      return c.json({ status: 'no_process', message: 'No gateway process found. Try again after triggering a startup.', stdout: '', stderr: '' });
    }
    const logs = await proc.getLogs?.();
    const stdout = logs?.stdout || '';
    const stderr = logs?.stderr || '';
    return c.json({
      status: 'ok',
      source: 'process',
      processId: proc.id,
      processStatus: proc.status,
      stdout,
      stderr,
      combined: [stderr, stdout].filter(Boolean).join('\n--- stdout ---\n').slice(-5000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ status: 'error', message: msg, stdout: '', stderr: '' }, 500);
  }
});

// POST /api/patch-cdp-url - Patch CDP URL in config without redeploy (auth: ?token=MOLTBOT_GATEWAY_TOKEN)
// Body: { "cdpUrl": "wss://moltbot-cdp.alex-94f.workers.dev/cdp?secret=FULL_SECRET" }
publicRoutes.post('/api/patch-cdp-url', async (c) => {
  const token = c.req.query('token');
  const expectedToken = c.env.MOLTBOT_GATEWAY_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return c.json({ error: 'Invalid or missing token', hint: 'Add ?token=YOUR_GATEWAY_TOKEN' }, 401);
  }
  let body: { cdpUrl?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body. Send: {"cdpUrl":"wss://moltbot-cdp.../cdp?secret=FULL_SECRET"}' }, 400);
  }
  const cdpUrl = (body.cdpUrl || '').trim();
  if (!/^wss?:\/\/.+/.test(cdpUrl)) {
    return c.json({
      error: 'Invalid cdpUrl',
      hint: 'Must be ws:// or wss:// URL with full secret, e.g. wss://moltbot-cdp.alex-94f.workers.dev/cdp?secret=YOUR_FULL_SECRET',
    }, 400);
  }
  const sandbox = c.get('sandbox');
  const patchScript = `
const fs=require('fs');
const p='/root/.openclaw/openclaw.json';
const cdpUrl=process.env.PATCH_CDP_URL||'';
const validColor='3498db';
if(!/^wss?:\\/\\/.+/.test(cdpUrl)){console.error('invalid');process.exit(1);}
let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){}
c.browser=c.browser||{};c.browser.profiles=c.browser.profiles||{};
const prof={cdpUrl,color:validColor};
c.browser.profiles.default=prof;c.browser.profiles.cloudflare=prof;
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('patched');
`.replace(/\n\s*/g, ' ').trim();
  try {
    const proc = await sandbox.startProcess(`node -e "${patchScript.replace(/"/g, '\\"')}"`, {
      env: { PATCH_CDP_URL: cdpUrl },
    });
    // Poll for completion - return as soon as we see "patched" (script runs in ~200ms)
    const deadline = Date.now() + 5000;
    let logs: { stdout?: string; stderr?: string } | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      logs = await proc.getLogs?.();
      if ((logs?.stdout || '').includes('patched')) break;
      if (proc.status !== 'running') break;
    }
    logs = logs ?? (await proc.getLogs?.());
    if ((logs?.stdout || '').includes('patched')) {
      return c.json({
        status: 'ok',
        message: 'CDP URL patched. Restart the gateway for changes to take effect (Admin UI → Restart Gateway).',
      });
    }
    return c.json({ status: 'error', message: 'Patch may have failed', stdout: logs?.stdout || '', stderr: logs?.stderr || '' }, 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ status: 'error', message: msg }, 500);
  }
});

const KILL_GATEWAY_TIMEOUT_MS = 60000;

// Force-kill route on PUBLIC path - served before proxy, so it never shows loading page
// GET /debug/kill-gateway-force - Page with Kill button
publicRoutes.get('/debug/kill-gateway-force', (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const base = `${protocol}://${host}`;
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Force Kill Gateway</title>
<style>body{font-family:system-ui;max-width:400px;margin:40px auto;padding:24px;background:#1a1a2e;color:#e0e0e0;}
.btn{background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:1rem;}
.btn:hover{background:#dc2626;}
.result{margin-top:16px;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:0.9rem;}
a{color:#60a5fa;}</style></head><body>
<h1>Force Kill Gateway</h1>
<p>Use when Admin won't load. Kills all OpenClaw processes.</p>
<button class="btn" id="killBtn">Kill everything</button>
<pre class="result" id="result"></pre>
<p style="margin-top:24px;font-size:0.85rem;"><a href="${base}/_admin/">Admin</a></p>
<script>
document.getElementById('killBtn').onclick=async function(){
  const r=document.getElementById('result');
  r.textContent='Sending...';
  try{
    const res=await fetch('${base}/debug/kill-gateway-force',{method:'POST'});
    const d=await res.json();
    r.textContent=JSON.stringify(d,null,2);
    r.style.background=d.ok?'#14532d':'#450a0a';
  }catch(e){
    r.textContent='Error: '+e.message;
    r.style.background='#450a0a';
  }
};
</script></body></html>`);
});

// POST /debug/kill-gateway-force - Force kill (public route, no proxy)
publicRoutes.post('/debug/kill-gateway-force', async (c) => {
  const sandbox = c.get('sandbox');
  const killTask = (async () => {
    const proc = await sandbox.startProcess(
      'pkill -9 -f openclaw 2>/dev/null; pkill -9 -f clawdbot 2>/dev/null; pkill -9 -f start-openclaw 2>/dev/null; pkill -9 -f start-moltbot 2>/dev/null; true'
    );
    await new Promise((r) => setTimeout(r, 3000));
    const logs = await proc.getLogs?.();
    return { ok: true, message: 'Force kill sent. Wait ~10s then start gateway.', stdout: logs?.stdout || '', stderr: logs?.stderr || '' };
  })();
  const timeout = new Promise<{ ok: false; error: string }>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          error: 'Container did not respond in 60s. It may still be booting after a deploy — wait 1-2 minutes and try again.',
        }),
      KILL_GATEWAY_TIMEOUT_MS
    )
  );
  try {
    const result = await Promise.race([killTask, timeout]);
    return c.json(result, result.ok ? 200 : 503);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
