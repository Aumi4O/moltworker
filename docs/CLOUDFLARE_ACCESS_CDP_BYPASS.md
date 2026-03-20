# Cloudflare Access: Bypass moltbot-cdp for Browser Jobs

If `moltbot-cdp.alex-94f.workers.dev` returns 302 to `alex-94f.cloudflareaccess.com`, OpenClaw cannot connect.

---

## Option: Delete Access app via API (recommended)

Removes the OpenClaw-CDP Access application so moltbot-cdp is no longer behind Access.

1. Create a Cloudflare API token with **Account - Zero Trust - Edit** permission.
2. Run:

```bash
CLOUDFLARE_API_TOKEN=your_token ./scripts/delete-cdp-access-app.sh
```

3. Verify: `curl -i https://moltbot-cdp.alex-94f.workers.dev/health` returns HTTP 200.

---

## Step 1: Open the Access application

1. Go to **https://one.dash.cloudflare.com** (or **Zero Trust** from the main dashboard)
2. **Access** → **Applications** (left sidebar)
3. Find the application that includes `moltbot-cdp.alex-94f.workers.dev`
   - May be named like "Workers" or "alex-94f.workers.dev"
   - Click it to open

---

## Step 2: Add a Bypass policy

1. Open the **Policies** tab
2. Click **Add a policy**
3. Configure:
   - **Policy name**: `Bypass moltbot-cdp`
   - **Action**: **Bypass**
   - **Configure rules**: click **Add include**
   - Select **Hostname**
   - Operator: **equals**
   - Value: `moltbot-cdp.alex-94f.workers.dev`
4. **Save**
5. Drag the new policy to the **top** of the list (Bypass must run before other policies)
6. Save the application

---

## Alternative: Disable Access for moltbot-cdp only

If Access is configured **per worker**:

1. **Workers & Pages** → **moltbot-cdp** → **Settings**
2. Find **Cloudflare Access** and turn it **OFF**
3. Save

---

## Alternative: Separate applications

If the app protects `*.alex-94f.workers.dev`:

1. Create a **new** Access application that protects only `moltbot-sandbox.alex-94f.workers.dev`
2. Disable or remove the old app that protects `*.alex-94f.workers.dev`
3. Result: moltbot-cdp will no longer be protected

---

## Verify

```bash
curl -i https://moltbot-cdp.alex-94f.workers.dev/health
```

Expected: **HTTP/2 200** and `{"ok":true,...}` — no 302, no login redirect.

---

# Bypass Access for moltbot-sandbox public API paths

If `POST /api/patch-cdp-url` or `GET /api/startup-logs` returns **HTTP 302**, Cloudflare Access is blocking the request at the edge before it reaches the Worker. These endpoints use `?token=MOLTBOT_GATEWAY_TOKEN` for auth and must bypass Access.

## Add a Bypass policy for public API paths

1. Go to **https://one.dash.cloudflare.com** → **Access** → **Applications**
2. Find the application that protects `moltbot-sandbox.alex-94f.workers.dev`
3. Open the **Policies** tab
4. Click **Add a policy**
5. Configure:
   - **Policy name**: `Bypass public API (patch-cdp-url, startup-logs, status)`
   - **Action**: **Bypass**
   - **Configure rules** → **Add include** → **Path**
   - Operator: **In** (or create separate rules)
   - Values: `/api/patch-cdp-url`, `/api/startup-logs`, `/api/status`
6. **Save**
7. Drag the new policy to the **top** of the list
8. Save the application

## Verify

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://moltbot-sandbox.alex-94f.workers.dev/api/patch-cdp-url?token=YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cdpUrl":"wss://moltbot-cdp.alex-94f.workers.dev/cdp?secret=YOUR_FULL_SECRET"}'
```

Expected: **HTTP 200** and `{"status":"ok","message":"CDP URL patched..."}` — no 302.
