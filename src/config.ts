/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/** Shorter timeout for checking if existing process is responsive (60s) - avoids long hangs on dead processes */
export const EXISTING_PROCESS_CHECK_MS = 60_000;

/** Mount path for R2 persistent storage inside the container */
export const R2_MOUNT_PATH = '/data/moltbot';

/** Subdirectory for versioned backups (keep last N for restore picker) */
export const R2_BACKUPS_DIR = `${R2_MOUNT_PATH}/backups`;

/** Maximum number of versioned backups to retain */
export const MAX_BACKUPS = 5;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}
