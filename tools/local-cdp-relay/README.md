# Local CDP Relay

Run **only** this on your Mac — no OpenClaw install. Use your local Chrome with cloud OpenClaw (moltworker).

## Why

- OpenClaw runs in the cloud (Cloudflare)
- You keep your logged-in Chrome on your Mac
- This relay exposes your Chrome via CDP so cloud OpenClaw can control it
- No need to install the full OpenClaw stack locally

## Quick start

### 1. Install (one-time)

```bash
cd tools/local-cdp-relay
npm install
```

### 2. Launch Chrome with remote debugging

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Or create a separate Chrome profile for automation and keep it open.

### 3. Run the relay

```bash
CDP_SECRET=your-secret-here node relay.js
```

Use a strong random secret, e.g. `openssl rand -hex 32`.

### 4. Expose via tunnel (so cloud can reach you)

```bash
cloudflared tunnel --url http://localhost:29222
```

You'll get a URL like `https://random-words.trycloudflare.com`.

### 5. Configure OpenClaw in cloud

In moltworker's OpenClaw config (or your openclaw.json), set:

```json
{
  "browser": {
    "profiles": {
      "mac-chrome": {
        "cdpUrl": "wss://random-words.trycloudflare.com/cdp?secret=your-secret-here",
        "color": "#00AA00"
      }
    }
  }
}
```

Use the tunnel URL and the same `CDP_SECRET` from step 3.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_SECRET` | (required) | Shared secret for auth |
| `RELAY_PORT` | 29222 | Port the relay listens on |
| Chrome port | 9222 | Use `--remote-debugging-port=9222` when launching Chrome |

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/health` | No | Health check |
| `/json/version` | `?secret=` | CDP discovery |
| `/cdp` | `?secret=` | WebSocket (CDP proxy) |

## Notes

- The relay binds to `127.0.0.1` only (not exposed to LAN by default)
- Use a tunnel (cloudflared, ngrok) to make it reachable from the cloud
- Keep `CDP_SECRET` secret — it's the only auth
