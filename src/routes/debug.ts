import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Debug routes for inspecting container state
 * Note: These routes should be protected by Cloudflare Access middleware
 * when mounted in the main app
 */
const debug = new Hono<AppEnv>();

// When invoked via middleware (bypassing route), sandbox is passed in env
debug.use('*', async (c, next) => {
  const env = c.env as AppEnv['Bindings'] & { __sandbox?: import('@cloudflare/sandbox').Sandbox };
  if (env.__sandbox) {
    c.set('sandbox', env.__sandbox);
  }
  return next();
});

// GET /debug or /debug/ - Debug index page (no gateway required)
debug.get('/', (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const base = `${protocol}://${host}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Debug - Moltworker</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #1a1a2e; color: #e0e0e0; }
    h1 { font-size: 1.4rem; margin-bottom: 24px; }
    a { color: #60a5fa; text-decoration: none; display: block; padding: 12px; background: #16213e; border-radius: 6px; margin-bottom: 8px; }
    a:hover { background: #0f3460; }
    .desc { font-size: 0.85rem; color: #94a3b8; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>Debug</h1>
  <a href="${base}/debug/oauth-codex"><strong>Codex OAuth</strong><span class="desc">Start gateway, sign in, connect Codex</span></a>
  <a href="${base}/debug/processes">Processes<span class="desc">List running processes</span></a>
  <a href="${base}/debug/version">Version<span class="desc">OpenClaw and Node versions</span></a>
  <a href="${base}/debug/env">Env<span class="desc">Environment config (sanitized)</span></a>
  <a href="${base}/debug/container-config">Container config<span class="desc">openclaw.json from container</span></a>
  <a href="${base}/debug/logs">Logs<span class="desc">Gateway process logs</span></a>
</body>
</html>`;

  return c.html(html);
});

// GET /debug/version - Returns version info from inside the container
debug.get('/version', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Get OpenClaw version
    const versionProcess = await sandbox.startProcess('openclaw --version');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const versionLogs = await versionProcess.getLogs();
    const moltbotVersion = (versionLogs.stdout || versionLogs.stderr || '').trim();

    // Get node version
    const nodeProcess = await sandbox.startProcess('node --version');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const nodeLogs = await nodeProcess.getLogs();
    const nodeVersion = (nodeLogs.stdout || '').trim();

    return c.json({
      moltbot_version: moltbotVersion,
      node_version: nodeVersion,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: `Failed to get version info: ${errorMessage}` }, 500);
  }
});

// GET /debug/processes - List all processes with optional logs
debug.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const includeLogs = c.req.query('logs') === 'true';

    const processData = await Promise.all(
      processes.map(async (p) => {
        const data: Record<string, unknown> = {
          id: p.id,
          command: p.command,
          status: p.status,
          startTime: p.startTime?.toISOString(),
          endTime: p.endTime?.toISOString(),
          exitCode: p.exitCode,
        };

        if (includeLogs) {
          try {
            const logs = await p.getLogs();
            data.stdout = logs.stdout || '';
            data.stderr = logs.stderr || '';
          } catch {
            data.logs_error = 'Failed to retrieve logs';
          }
        }

        return data;
      }),
    );

    // Sort by status (running first, then starting, completed, failed)
    // Within each status, sort by startTime descending (newest first)
    const statusOrder: Record<string, number> = {
      running: 0,
      starting: 1,
      completed: 2,
      failed: 3,
    };

    processData.sort((a, b) => {
      const statusA = statusOrder[a.status as string] ?? 99;
      const statusB = statusOrder[b.status as string] ?? 99;
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      // Within same status, sort by startTime descending
      const timeA = (a.startTime as string) || '';
      const timeB = (b.startTime as string) || '';
      return timeB.localeCompare(timeA);
    });

    return c.json({ count: processes.length, processes: processData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the moltbot gateway HTTP API
debug.get('/gateway-api', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path') || '/';
  const MOLTBOT_PORT = 18789;

  try {
    const url = `http://localhost:${MOLTBOT_PORT}${path}`;
    const response = await sandbox.containerFetch(new Request(url), MOLTBOT_PORT);
    const contentType = response.headers.get('content-type') || '';

    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return c.json({
      path,
      status: response.status,
      contentType,
      body,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/cli - Test OpenClaw CLI commands
debug.get('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const cmd = c.req.query('cmd') || 'openclaw --help';

  try {
    const proc = await sandbox.startProcess(cmd);

    // Wait longer for command to complete
    let attempts = 0;
    while (attempts < 30) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 500));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    return c.json({
      command: cmd,
      status: proc.status,
      exitCode: proc.exitCode,
      attempts,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, command: cmd }, 500);
  }
});

// GET /debug/logs - Returns container logs for debugging
debug.get('/logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processId = c.req.query('id');
    let process = null;

    if (processId) {
      const processes = await sandbox.listProcesses();
      process = processes.find((p) => p.id === processId);
      if (!process) {
        return c.json(
          {
            status: 'not_found',
            message: `Process ${processId} not found`,
            stdout: '',
            stderr: '',
          },
          404,
        );
      }
    } else {
      process = await findExistingMoltbotProcess(sandbox);
      if (!process) {
        return c.json({
          status: 'no_process',
          message: 'No Moltbot process is currently running',
          stdout: '',
          stderr: '',
        });
      }
    }

    const logs = await process.getLogs();
    return c.json({
      status: 'ok',
      process_id: process.id,
      process_status: process.status,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        status: 'error',
        message: `Failed to get logs: ${errorMessage}`,
        stdout: '',
        stderr: '',
      },
      500,
    );
  }
});

// GET /debug/ws-test - Interactive WebSocket debug page
debug.get('/ws-test', async (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WebSocket Debug</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    #log { white-space: pre-wrap; background: #000; padding: 10px; height: 400px; overflow-y: auto; border: 1px solid #333; }
    button { margin: 5px; padding: 10px; }
    input { padding: 10px; width: 300px; }
    .error { color: #f00; }
    .sent { color: #0ff; }
    .received { color: #0f0; }
    .info { color: #ff0; }
  </style>
</head>
<body>
  <h1>WebSocket Debug Tool</h1>
  <div>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
    <button id="clear">Clear Log</button>
  </div>
  <div style="margin: 10px 0;">
    <input id="message" placeholder="JSON message to send..." />
    <button id="send" disabled>Send</button>
  </div>
  <div style="margin: 10px 0;">
    <button id="sendConnect" disabled>Send Connect Frame</button>
  </div>
  <div id="log"></div>
  
  <script>
    const wsUrl = '${wsProtocol}://${host}/';
    let ws = null;
    
    const log = (msg, className = '') => {
      const logEl = document.getElementById('log');
      const time = new Date().toISOString().substr(11, 12);
      logEl.innerHTML += '<span class="' + className + '">[' + time + '] ' + msg + '</span>\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
    
    document.getElementById('connect').onclick = () => {
      log('Connecting to ' + wsUrl + '...', 'info');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        log('Connected!', 'info');
        document.getElementById('connect').disabled = true;
        document.getElementById('disconnect').disabled = false;
        document.getElementById('send').disabled = false;
        document.getElementById('sendConnect').disabled = false;
      };
      
      ws.onmessage = (e) => {
        log('RECV: ' + e.data, 'received');
        try {
          const parsed = JSON.parse(e.data);
          log('  Parsed: ' + JSON.stringify(parsed, null, 2), 'received');
        } catch {}
      };
      
      ws.onerror = (e) => {
        log('ERROR: ' + JSON.stringify(e), 'error');
      };
      
      ws.onclose = (e) => {
        log('Closed: code=' + e.code + ' reason=' + e.reason, 'info');
        document.getElementById('connect').disabled = false;
        document.getElementById('disconnect').disabled = true;
        document.getElementById('send').disabled = true;
        document.getElementById('sendConnect').disabled = true;
        ws = null;
      };
    };
    
    document.getElementById('disconnect').onclick = () => {
      if (ws) ws.close();
    };
    
    document.getElementById('clear').onclick = () => {
      document.getElementById('log').innerHTML = '';
    };
    
    document.getElementById('send').onclick = () => {
      const msg = document.getElementById('message').value;
      if (ws && msg) {
        log('SEND: ' + msg, 'sent');
        ws.send(msg);
      }
    };
    
    document.getElementById('sendConnect').onclick = () => {
      if (!ws) return;
      const connectFrame = {
        type: 'req',
        id: 'debug-' + Date.now(),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'debug-tool',
            displayName: 'Debug Tool',
            version: '1.0.0',
            mode: 'webchat',
            platform: 'web'
          },
          role: 'operator',
          scopes: []
        }
      };
      const msg = JSON.stringify(connectFrame);
      log('SEND Connect Frame: ' + msg, 'sent');
      ws.send(msg);
    };
    
    document.getElementById('message').onkeypress = (e) => {
      if (e.key === 'Enter') document.getElementById('send').click();
    };
  </script>
</body>
</html>`;

  return c.html(html);
});

// GET /debug/oauth-codex - Codex OAuth setup page
debug.get('/oauth-codex', async (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const baseUrl = `${protocol}://${host}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Codex OAuth - Moltworker</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 20px; background: #1a1a2e; color: #e0e0e0; }
    h1 { font-size: 1.4rem; margin-bottom: 24px; }
    .step { background: #16213e; padding: 20px; border-radius: 8px; margin-bottom: 16px; }
    .step-num { display: inline-block; width: 24px; height: 24px; background: #0f3460; border-radius: 50%; text-align: center; line-height: 24px; margin-right: 8px; }
    .btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 1rem; }
    .btn:hover { background: #2563eb; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    input { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #333; background: #1a1a2e; color: #e0e0e0; margin: 8px 0; }
    .status { font-size: 0.9rem; margin-top: 8px; color: #94a3b8; }
    .success { color: #4ade80; }
    .error { color: #f87171; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <h1>Codex OAuth Setup</h1>
  <p style="margin-bottom: 24px; color: #94a3b8;">Use your free Codex subscription. No API key needed.</p>

  <div class="step">
    <p><span class="step-num">0</span><strong>Start gateway</strong></p>
    <p style="margin: 12px 0; font-size: 0.9rem; color: #94a3b8;">The gateway must be running before OAuth. Set <code>CODEX_ONLY=true</code> via <code>wrangler secret put CODEX_ONLY</code> if you have no API key.</p>
    <button class="btn" id="startBtn" onclick="startGateway()">Start gateway</button>
    <p id="step0Status" class="status"></p>
  </div>

  <div class="step">
    <p><span class="step-num">1</span><strong>Sign in with ChatGPT</strong></p>
    <p style="margin: 12px 0; font-size: 0.9rem;">Open this link and sign in with your OpenAI account:</p>
    <a href="https://auth.openai.com/oauth/authorize?client_id=codex&response_type=code&redirect_uri=http://localhost:1455/auth/callback&scope=openid%20profile%20email%20offline_access" target="_blank" rel="noopener" class="btn" style="display: inline-block; text-decoration: none;">Sign in with ChatGPT</a>
  </div>

  <div class="step">
    <p><span class="step-num">2</span><strong>Paste the redirect URL</strong></p>
    <p style="margin: 12px 0; font-size: 0.9rem;">After signing in, copy the full URL from your browser and paste it here:</p>
    <input type="text" id="callbackUrl" placeholder="http://localhost:1455/auth/callback?code=...&scope=...&state=..." />
    <button class="btn" id="connectBtn" onclick="connectCodex()" style="margin-top: 8px;">Connect</button>
    <p id="step2Status" class="status"></p>
  </div>

  <div class="step">
    <p><span class="step-num">3</span><strong>Go to Chat</strong></p>
    <p style="margin: 12px 0; font-size: 0.9rem;">Once connected, open the chat:</p>
    <a href="${baseUrl}/" class="btn" style="display: inline-block; text-decoration: none;">Go to Chat</a>
  </div>

  <script>
    async function startGateway() {
      const btn = document.getElementById('startBtn');
      const status = document.getElementById('step0Status');
      btn.disabled = true;
      status.textContent = 'Starting... (this may take 1-2 minutes)';
      status.className = 'status';
      try {
        const r = await fetch('${baseUrl}/debug/start-gateway', { method: 'POST', credentials: 'include' });
        const data = await r.json();
        if (data.status === 'running' || data.ok) {
          status.textContent = 'Gateway is running.';
          status.className = 'status success';
        } else {
          status.textContent = data.message || data.error || 'Failed';
          status.className = 'status error';
          if ((data.message || '').includes('ANTHROPIC_API_KEY')) {
            status.textContent += ' Set CODEX_ONLY=true: wrangler secret put CODEX_ONLY';
          }
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
      btn.disabled = false;
    }
    async function connectCodex() {
      const url = document.getElementById('callbackUrl').value.trim();
      const status = document.getElementById('step2Status');
      if (!url) { status.textContent = 'Paste the URL first'; status.className = 'status error'; return; }
      status.textContent = 'Connecting...';
      status.className = 'status';
      try {
        const r = await fetch('${baseUrl}/debug/oauth-codex/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callbackUrl: url }),
          credentials: 'include'
        });
        const data = await r.json();
        if (data.ok || data.success) {
          status.textContent = 'Connected! Go to Chat.';
          status.className = 'status success';
        } else {
          status.textContent = data.error || data.message || 'Failed';
          status.className = 'status error';
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'status error';
      }
    }
  </script>
</body>
</html>`;

  return c.html(html);
});

// POST /debug/oauth-codex/exchange - Exchange OAuth callback URL for tokens
debug.post('/oauth-codex/exchange', async (c) => {
  const sandbox = c.get('sandbox');
  let body: { callbackUrl?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const callbackUrl = body?.callbackUrl?.trim();
  if (!callbackUrl) {
    return c.json({ error: 'callbackUrl is required' }, 400);
  }

  const existing = await findExistingMoltbotProcess(sandbox);
  if (!existing) {
    return c.json({ error: 'Gateway not running. Start the gateway first.' }, 503);
  }

  try {
    const gatewayUrl = `http://localhost:18789/auth/openai-codex/callback?url=${encodeURIComponent(callbackUrl)}`;
    const r = await sandbox.containerFetch(new Request(gatewayUrl, { method: 'POST' }), 18789);
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(
      r.ok ? { ok: true, ...data } : { error: String(data?.error ?? r.statusText) },
      r.status as 200 | 400 | 503,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

async function handleStartGateway(c: import('hono').Context<AppEnv>) {
  const sandbox = c.get('sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');
  try {
    await ensureMoltbotGateway(sandbox, c.env);
    return c.json({ status: 'running', ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    let stderr = '';
    let stdout = '';
    try {
      const procs = await sandbox.listProcesses();
      const gatewayProc = procs.find(
        (p) =>
          p.command.includes('start-openclaw.sh') || p.command.includes('openclaw gateway'),
      );
      if (gatewayProc) {
        const logs = await gatewayProc.getLogs();
        stderr = logs.stderr || '';
        stdout = logs.stdout || '';
      }
    } catch {
      /* ignore */
    }
    return c.json(
      {
        status: 'error',
        message: msg,
        stderr: stderr || undefined,
        stdout: stdout || undefined,
        hint:
          msg.includes('ANTHROPIC_API_KEY') || msg.includes('auth')
            ? 'Set CODEX_ONLY=true: wrangler secret put CODEX_ONLY'
            : 'Check worker logs: npx wrangler tail',
      },
      503,
    );
  }
}

// POST /debug/start-gateway - Start the gateway (for Codex OAuth flow)
debug.post('/start-gateway', handleStartGateway);

// GET /debug/start-gateway - Same as POST (for direct URL access / debugging)
debug.get('/start-gateway', handleStartGateway);

// GET /debug/env - Show environment configuration (sanitized)
debug.get('/env', async (c) => {
  return c.json({
    has_anthropic_key: !!c.env.ANTHROPIC_API_KEY,
    has_openai_key: !!c.env.OPENAI_API_KEY,
    has_gateway_token: !!c.env.MOLTBOT_GATEWAY_TOKEN,
    has_r2_access_key: !!c.env.R2_ACCESS_KEY_ID,
    has_r2_secret_key: !!c.env.R2_SECRET_ACCESS_KEY,
    has_cf_account_id: !!c.env.CF_ACCOUNT_ID,
    dev_mode: c.env.DEV_MODE,
    debug_routes: c.env.DEBUG_ROUTES,
    bind_mode: 'lan',
    cf_access_team_domain: c.env.CF_ACCESS_TEAM_DOMAIN,
    has_cf_access_aud: !!c.env.CF_ACCESS_AUD,
  });
});

// GET /debug/container-config - Read the moltbot config from inside the container
debug.get('/container-config', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const proc = await sandbox.startProcess('cat /root/.openclaw/openclaw.json');

    let attempts = 0;
    while (attempts < 10) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 200));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    let config = null;
    try {
      config = JSON.parse(stdout);
    } catch {
      // Not valid JSON
    }

    return c.json({
      status: proc.status,
      exitCode: proc.exitCode,
      config,
      raw: config ? undefined : stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

export { debug };
