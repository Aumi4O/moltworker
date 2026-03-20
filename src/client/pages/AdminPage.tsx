/**
 * Admin UI only: gateway restart, device pairing, CDP URL patch.
 * No R2 backup / sync / restore controls (by design; persistence is rclone in the container).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  listDevices,
  approveDevice,
  approveAllDevices,
  restartGateway,
  patchCdpUrl,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
} from '../api';
import './AdminPage.css';

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatTimeAgo(ts: number) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AdminPage() {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [restartInProgress, setRestartInProgress] = useState(false);
  const [cdpUrlInput, setCdpUrlInput] = useState('');
  const [cdpPatchInProgress, setCdpPatchInProgress] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data: DeviceListResponse = await listDevices();
      setPending(data.pending || []);
      setPaired(data.paired || []);

      if (data.error) {
        setError(data.error);
      } else if (data.parseError) {
        setError(`Parse error: ${data.parseError}`);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch devices');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleApprove = async (requestId: string) => {
    setActionInProgress(requestId);
    try {
      const result = await approveDevice(requestId);
      if (result.success) {
        await fetchDevices();
      } else {
        setError(result.error || 'Approval failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve device');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleApproveAll = async () => {
    if (pending.length === 0) return;

    setActionInProgress('all');
    try {
      const result = await approveAllDevices();
      if (result.failed && result.failed.length > 0) {
        setError(`Failed to approve ${result.failed.length} device(s)`);
      }
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve devices');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRestartGateway = async () => {
    if (
      !confirm(
        'Are you sure you want to restart the gateway? This will disconnect all clients temporarily.',
      )
    ) {
      return;
    }

    setRestartInProgress(true);
    try {
      const result = await restartGateway();
      if (result.success) {
        setError(null);
        alert('Gateway restart initiated. Clients will reconnect automatically.');
      } else {
        setError(result.error || 'Failed to restart gateway');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart gateway');
    } finally {
      setRestartInProgress(false);
    }
  };

  const handlePatchCdpUrl = async () => {
    const url = cdpUrlInput.trim();
    if (!url) {
      setError('Enter the full CDP URL (wss://moltbot-cdp.../cdp?secret=...)');
      return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      setError('CDP URL must start with ws:// or wss://');
      return;
    }
    setCdpPatchInProgress(true);
    setError(null);
    try {
      const result = await patchCdpUrl(url);
      if (result.success) {
        setCdpUrlInput('');
        alert(result.message || 'CDP URL patched. Restart the gateway for changes to take effect.');
      } else {
        setError(result.error || 'Patch failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to patch CDP URL');
    } finally {
      setCdpPatchInProgress(false);
    }
  };

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      <aside className="pairing-notice" aria-label="Device pairing instructions">
        <h2 className="pairing-notice-title">You need to pair devices</h2>
        <p>
          OpenClaw will not talk to a new browser, the Control UI, or the CLI until you <strong>approve</strong>{' '}
          it here. This is separate from Cloudflare Access.
        </p>
        <p className="pairing-notice-important">
          <strong>Nothing appears under Pending until chat actually connects to the gateway.</strong> If the Control UI
          shows &quot;invalid or missing token&quot; or stays disconnected, fix the gateway token first — no pairing
          request is created until the WebSocket gets past auth.
        </p>
        <ol className="pairing-notice-steps">
          <li>
            Open <a href="/">Control UI (chat)</a> with a valid <code>?token=…</code> (your{' '}
            <code>MOLTBOT_GATEWAY_TOKEN</code>) if the UI asks for it.
          </li>
          <li>Wait until the dashboard is trying to connect (not stuck on token/offline).</li>
          <li>Return here, wait <strong>10–15s</strong>, click <strong>Refresh</strong> — the new client should show as{' '}
            <strong>pending</strong>.
          </li>
          <li>Click <strong>Approve</strong>, then refresh chat.</li>
        </ol>
        <p className="pairing-notice-hint">
          <strong>CLI vs browser:</strong> a paired <code>cli</code> device is your terminal only. Opening chat in the
          browser creates a <em>separate</em> device — use incognito if this profile was already paired.
        </p>
      </aside>

      {/* Core admin: gateway recycle + device pairing (same as upstream moltworker admin). */}
      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>Gateway</h2>
          <button
            className="btn btn-danger"
            onClick={handleRestartGateway}
            disabled={restartInProgress}
            type="button"
          >
            {restartInProgress && <ButtonSpinner />}
            {restartInProgress ? 'Restarting...' : 'Restart Gateway'}
          </button>
        </div>
        <p className="hint">
          Stops and starts the OpenClaw gateway process in the sandbox. Use this to apply config changes,
          recover from a stuck gateway, or clear errors. Clients disconnect briefly and should reconnect.
        </p>
      </section>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading devices...</p>
        </div>
      ) : (
        <>
          <section className="devices-section">
            <div className="section-header">
              <h2>Pending Pairing Requests</h2>
              <div className="header-actions">
                {pending.length > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={handleApproveAll}
                    disabled={actionInProgress !== null}
                  >
                    {actionInProgress === 'all' && <ButtonSpinner />}
                    {actionInProgress === 'all'
                      ? 'Approving...'
                      : `Approve All (${pending.length})`}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={fetchDevices} disabled={loading}>
                  Refresh
                </button>
              </div>
            </div>

            {pending.length === 0 ? (
              <div className="empty-state empty-state-pending">
                <p>
                  <strong>No pending pairing requests</strong>
                </p>
                <p className="hint">That usually means no new client has reached the gateway yet, or it is already paired.</p>
                <ul className="pending-troubleshoot">
                  <li>
                    Open <a href="/">chat</a> with a working gateway token — fix token/CORS errors first.
                  </li>
                  <li>Click <strong>Refresh</strong> here after 10–15s.</li>
                  <li>
                    Seeing a paired <strong>cli</strong> entry? Your <strong>browser</strong> is still a different
                    client — open chat in that browser (try incognito).
                  </li>
                </ul>
              </div>
            ) : (
              <div className="devices-grid">
                {pending.map((device) => (
                  <div key={device.requestId} className="device-card pending">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge pending">Pending</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      {device.remoteIp && (
                        <div className="detail-row">
                          <span className="label">IP:</span>
                          <span className="value">{device.remoteIp}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Requested:</span>
                        <span className="value" title={formatTimestamp(device.ts)}>
                          {formatTimeAgo(device.ts)}
                        </span>
                      </div>
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-success"
                        onClick={() => handleApprove(device.requestId)}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === device.requestId && <ButtonSpinner />}
                        {actionInProgress === device.requestId ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="devices-section">
            <div className="section-header">
              <h2>Paired Devices</h2>
            </div>

            {paired.length === 0 ? (
              <div className="empty-state">
                <p>No paired devices</p>
              </div>
            ) : (
              <div className="devices-grid">
                {paired.map((device, index) => (
                  <div key={device.deviceId || index} className="device-card paired">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge paired">Paired</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Paired:</span>
                        <span className="value" title={formatTimestamp(device.approvedAtMs)}>
                          {formatTimeAgo(device.approvedAtMs)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section className="devices-section cdp-section">
        <div className="section-header">
          <h2>Browser automation (CDP)</h2>
        </div>
        <p className="hint">
          Patch the CDP URL so OpenClaw can connect to moltbot-cdp for browser jobs. Use the full URL
          including the secret, e.g. wss://moltbot-cdp.xxx.workers.dev/cdp?secret=...
        </p>
        <div className="cdp-patch-form">
          <input
            type="text"
            className="cdp-url-input"
            placeholder="wss://moltbot-cdp.xxx.workers.dev/cdp?secret=..."
            value={cdpUrlInput}
            onChange={(e) => setCdpUrlInput(e.target.value)}
          />
          <button
            className="btn btn-primary"
            onClick={handlePatchCdpUrl}
            disabled={cdpPatchInProgress}
            type="button"
          >
            {cdpPatchInProgress && <ButtonSpinner />}
            {cdpPatchInProgress ? 'Patching...' : 'Patch CDP URL'}
          </button>
        </div>
      </section>
    </div>
  );
}
