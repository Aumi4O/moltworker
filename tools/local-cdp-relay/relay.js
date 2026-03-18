#!/usr/bin/env node
/**
 * Local CDP Relay
 *
 * Run ONLY this on your Mac - no OpenClaw install needed.
 * Exposes your local Chrome via CDP so cloud OpenClaw (moltworker) can connect.
 *
 * 1. Launch Chrome: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 * 2. Run: node relay.js (or CDP_SECRET=xxx node relay.js)
 * 3. Tunnel: cloudflared tunnel --url http://localhost:29222
 * 4. Configure OpenClaw in cloud with cdpUrl: wss://<tunnel-host>/cdp?secret=<CDP_SECRET>
 */

import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const CHROME_PORT = 9222;
const RELAY_PORT = Number(process.env.RELAY_PORT) || 29222;
const SECRET = process.env.CDP_SECRET || '';

if (!SECRET) {
  console.error('Set CDP_SECRET: CDP_SECRET=your-secret node relay.js');
  process.exit(1);
}

async function getChromeWsUrl() {
  const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
  if (!res.ok) throw new Error(`Chrome not reachable at :${CHROME_PORT}. Launch it with:\n  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${CHROME_PORT}`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'text/plain' });
  res.end('unauthorized');
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost`);
  const secret = url.searchParams.get('secret');

  if (url.pathname === '/health') {
    return json(res, { ok: true, service: 'local-cdp-relay', ts: new Date().toISOString() });
  }

  if (url.pathname === '/json/version') {
    if (!secret || secret !== SECRET) return unauthorized(res);
    try {
      const chromeRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
      const data = await chromeRes.json();
      const host = req.headers.host || `localhost:${RELAY_PORT}`;
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      data.webSocketDebuggerUrl = `${protocol}://${host}/cdp?secret=${encodeURIComponent(secret)}`;
      return json(res, data);
    } catch (e) {
      return json(res, { error: e.message }, 503);
    }
  }

  if (url.pathname === '/json/list' || url.pathname === '/json') {
    if (!secret || secret !== SECRET) return unauthorized(res);
    try {
      const chromeRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`);
      const data = await chromeRes.json();
      return json(res, data);
    } catch (e) {
      return json(res, { error: e.message }, 503);
    }
  }

  if (url.pathname === '/') {
    return json(res, {
      service: 'local-cdp-relay',
      hint: 'Tunnel this server and use wss://<tunnel>/cdp?secret=<CDP_SECRET> in OpenClaw',
      endpoints: { '/health': 'Health', '/json/version': 'CDP discovery', '/cdp': 'WebSocket' },
    });
  }

  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost`);
  if (url.pathname !== '/cdp') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== SECRET) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }

  let chromeWsUrl;
  try {
    chromeWsUrl = await getChromeWsUrl();
  } catch (e) {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n${e.message}`);
    return;
  }

  const chromeWs = new WebSocket(chromeWsUrl);
  chromeWs.on('open', () => {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      clientWs.on('message', (d) => chromeWs.send(d));
      chromeWs.on('message', (d) => clientWs.send(d));
      clientWs.on('close', () => chromeWs.close());
      chromeWs.on('close', () => clientWs.close());
    });
  });
  chromeWs.on('error', () => socket.end());
});

server.listen(RELAY_PORT, '127.0.0.1', () => {
  console.log(`CDP relay on http://127.0.0.1:${RELAY_PORT}`);
  console.log('Tunnel with: cloudflared tunnel --url http://localhost:' + RELAY_PORT);
  console.log('Then in OpenClaw: cdpUrl = "wss://<tunnel-host>/cdp?secret=..."');
});
