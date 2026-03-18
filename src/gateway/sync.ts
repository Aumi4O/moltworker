import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, R2_BACKUPS_DIR, MAX_BACKUPS } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/ (IDENTITY.md, MEMORY.md, memory/, assets/)
 * - Skills: /root/clawd/skills/ → R2:/skills/
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Determine which config directory exists
  // Check new path first, fall back to legacy
  // Use exit code (0 = exists) rather than stdout parsing to avoid log-flush races
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await sandbox.startProcess('test -f /root/.openclaw/openclaw.json');
    await waitForProcess(checkNew, 5000);
    if (checkNew.exitCode !== 0) {
      const checkLegacy = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json');
      await waitForProcess(checkLegacy, 5000);
      if (checkLegacy.exitCode === 0) {
        configDir = '/root/.clawdbot';
      } else {
        // List config dir contents to help diagnose
        const lsProc = await sandbox.startProcess(
          'ls -la /root/.openclaw/ 2>/dev/null || echo "dir missing"; ls -la /root/.clawdbot/ 2>/dev/null || echo "legacy dir missing"',
        );
        await waitForProcess(lsProc, 5000);
        const lsLogs = await lsProc.getLogs();
        const dirContents = lsLogs.stdout?.trim() || lsLogs.stderr?.trim() || 'could not list';
        console.error('[sync] No config found. Dir contents:', dirContents);
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: `Neither openclaw.json nor clawdbot.json found. Gateway must start successfully at least once to create config. Listing: ${dirContents}`,
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Sync to the new openclaw/ R2 prefix (even if source is legacy .clawdbot)
  // Also sync workspace directory (excluding skills since they're synced separately)
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/ && rsync -r --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/workspace/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;

  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Check for success by reading the timestamp file
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      // Save versioned backup (for restore picker)
      const safeTs = lastSync.replace(/[:+]/g, '-').replace(/\.\d+Z?$/i, '');
      const backupDir = `${R2_BACKUPS_DIR}/${safeTs}`;
      const versionCmd = `mkdir -p ${backupDir} && cp -a ${R2_MOUNT_PATH}/openclaw ${backupDir}/ && cp -a ${R2_MOUNT_PATH}/workspace ${backupDir}/ && cp -a ${R2_MOUNT_PATH}/skills ${backupDir}/`;
      try {
        const verProc = await sandbox.startProcess(versionCmd);
        await waitForProcess(verProc, 15000);
      } catch {
        // Non-fatal: main backup succeeded
      }
      // Prune old backups (keep last MAX_BACKUPS)
      const pruneCmd = `cd ${R2_BACKUPS_DIR} 2>/dev/null && ls -1t 2>/dev/null | tail -n +${MAX_BACKUPS + 1} | while read d; do [ -n "$d" ] && rm -rf "$d"; done`;
      try {
        await sandbox.startProcess(`sh -c '${pruneCmd}'`);
      } catch {
        // Ignore
      }
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export interface BackupEntry {
  timestamp: string;
  displayName: string;
}

/**
 * List versioned backups available for restore (newest first)
 */
export async function listBackups(sandbox: Sandbox, env: MoltbotEnv): Promise<{ backups: BackupEntry[]; error?: string }> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { backups: [], error: 'R2 not configured' };
  }
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) return { backups: [], error: 'R2 mount failed' };

  try {
    const proc = await sandbox.startProcess(`ls -1t ${R2_BACKUPS_DIR} 2>/dev/null || true`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const lines = (logs.stdout || '')
      .trim()
      .split('\n')
      .filter((s) => s.length > 0);
    const backups: BackupEntry[] = lines.map((ts) => ({
      timestamp: ts,
      displayName: ts.replace(/T/, ' ').replace(/-\d{2}$/, ''),
    }));
    return { backups };
  } catch {
    return { backups: [], error: 'Failed to list backups' };
  }
}

export interface RestoreResult {
  success: boolean;
  error?: string;
  details?: string;
}

/**
 * Restore from a versioned backup. Copies backup data to main paths and updates .last-sync.
 */
export async function restoreFromBackup(
  sandbox: Sandbox,
  env: MoltbotEnv,
  timestamp: string,
): Promise<RestoreResult> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 not configured' };
  }
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) return { success: false, error: 'R2 mount failed' };

  const backupDir = `${R2_BACKUPS_DIR}/${timestamp}`;
  if (!/^[\d\-T]+$/.test(timestamp)) {
    return { success: false, error: 'Invalid timestamp' };
  }

  try {
    const restoreCmd = `cp -a ${backupDir}/openclaw/. /root/.openclaw/ && cp -a ${backupDir}/workspace/. /root/clawd/ && cp -a ${backupDir}/skills/. /root/clawd/skills/ && echo "${timestamp.replace(/T/, ' ')}" > ${R2_MOUNT_PATH}/.last-sync && cp ${R2_MOUNT_PATH}/.last-sync /root/.openclaw/.last-sync`;
    const proc = await sandbox.startProcess(restoreCmd);
    await waitForProcess(proc, 30000);
    if (proc.exitCode !== 0 && proc.exitCode != null) {
      const logs = await proc.getLogs();
      return { success: false, error: 'Restore failed', details: logs.stderr || logs.stdout };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: 'Restore error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

