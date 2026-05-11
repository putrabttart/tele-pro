import { PrismaClient } from "@prisma/client";
import { sleep } from "../utils/sleep";

// ═══════════════════════════════════════════════════════════
// PRISMA CLIENT WITH CONNECTION POOL OPTIMIZATION
// ═══════════════════════════════════════════════════════════
//
// Supabase PgBouncer (port 6543) memiliki batasan:
// - connection_limit=1 di URL berarti Prisma hanya bisa buka 1 koneksi per client
// - Ini menyebabkan "Timed out fetching a new connection from the connection pool"
//   saat banyak query paralel (broadcast + scheduler + heartbeat)
//
// Solusi:
// 1. Override connection_limit via datasource URL (naikkan ke 10)
// 2. Naikkan pool timeout dari 10s ke 30s
// 3. Tambahkan retry wrapper untuk semua database operations
// ═══════════════════════════════════════════════════════════

const buildDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL ?? "";

  // Override connection_limit jika masih 1
  let url = baseUrl;

  // Replace connection_limit=1 with connection_limit=10
  if (url.includes("connection_limit=1")) {
    url = url.replace("connection_limit=1", "connection_limit=10");
  } else if (!url.includes("connection_limit=")) {
    // Add connection_limit if not present
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}connection_limit=10`;
  }

  // Add pool_timeout if not present (30 seconds)
  if (!url.includes("pool_timeout=")) {
    url = `${url}&pool_timeout=30`;
  }

  return url;
};

// Override the DATABASE_URL before Prisma reads it
const optimizedUrl = buildDatabaseUrl();
process.env.DATABASE_URL = optimizedUrl;

export const prisma = new PrismaClient({
  log: ["error", "warn"],
  datasources: {
    db: {
      url: optimizedUrl
    }
  }
});

// ═══════════════════════════════════════════════════════════
// DATABASE RETRY WRAPPER
// ═══════════════════════════════════════════════════════════
//
// Wraps any Prisma operation with automatic retry on transient errors:
// - Connection pool timeout
// - Can't reach database server
// - Connection reset
// - Prepared statement already exists (PgBouncer issue)
// ═══════════════════════════════════════════════════════════

const RETRYABLE_ERROR_PATTERNS = [
  /timed out fetching a new connection from the connection pool/i,
  /can't reach database server/i,
  /connection reset/i,
  /connection refused/i,
  /connection closed/i,
  /prepared statement .* already exists/i,
  /server closed the connection unexpectedly/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /socket hang up/i
];

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
  }
  return false;
};

/**
 * Execute a database operation with automatic retry on transient connection errors.
 * 
 * Usage:
 * ```ts
 * const result = await dbRetry(() => prisma.broadcastRun.findUnique({ where: { id } }));
 * ```
 * 
 * @param operation - Async function that performs the Prisma operation
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param baseDelayMs - Base delay between retries in ms (default: 2000)
 * @returns The result of the operation
 */
export const dbRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 2000
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s (total wait ~62s before giving up)
      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), 30000);
      // eslint-disable-next-line no-console
      console.warn(`[dbRetry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs}ms...`);
      await sleep(delayMs);

      // Try to disconnect and reconnect on connection errors
      if (attempt >= 1) {
        try {
          await prisma.$disconnect();
          await prisma.$connect();
        } catch {
          // Ignore reconnect errors, next attempt will try naturally
        }
      }
    }
  }

  throw lastError;
};
