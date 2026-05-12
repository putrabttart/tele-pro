import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

// ═══════════════════════════════════════════════════════════
// CONNECTION POOL OPTIMIZATION
// ═══════════════════════════════════════════════════════════

const buildDatabaseUrl = () => {
  const baseUrl = process.env.DATABASE_URL ?? "";
  let url = baseUrl;

  if (url.includes("connection_limit=1")) {
    url = url.replace("connection_limit=1", "connection_limit=10");
  } else if (!url.includes("connection_limit=")) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}connection_limit=10`;
  }

  if (!url.includes("pool_timeout=")) {
    url = `${url}&pool_timeout=30`;
  }

  return url;
};

const optimizedUrl = buildDatabaseUrl();

export const prisma = new PrismaClient({
  log: ["error", "warn"],
  datasources: {
    db: {
      url: optimizedUrl
    }
  }
});

// ═══════════════════════════════════════════════════════════
// PRISMA RETRY MIDDLEWARE
// Automatically retries on transient connection errors.
// This handles "Can't reach database server" without needing
// to wrap every single query manually.
// ═══════════════════════════════════════════════════════════

const RETRYABLE_PATTERNS = [
  /can't reach database server/i,
  /timed out fetching a new connection from the connection pool/i,
  /connection reset/i,
  /connection refused/i,
  /connection closed/i,
  /server closed the connection unexpectedly/i,
  /prepared statement .* already exists/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i
];

const isRetryable = (error: unknown): boolean => {
  if (error instanceof Error) {
    return RETRYABLE_PATTERNS.some((p) => p.test(error.message));
  }
  return false;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

// Prisma client extension for automatic retry
prisma.$use(async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<any>) => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await next(params);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 15000);
      // eslint-disable-next-line no-console
      console.warn(`[prisma-retry] ${params.model}.${params.action} failed, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw lastError;
});
