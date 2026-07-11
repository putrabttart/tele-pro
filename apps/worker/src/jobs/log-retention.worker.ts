import { RunStatus } from "@prisma/client";
import { prisma, dbRetry } from "../config/prisma";
import { logActivity } from "../utils/logger";

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 30);
const RETENTION_INTERVAL_MS = Number(process.env.LOG_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

const getCutoff = () => {
  const days = Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0 ? RETENTION_DAYS : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
};

export const cleanupOldLogs = async () => {
  const cutoff = getCutoff();

  const [sendLogs, activityLogs] = await dbRetry(() =>
    prisma.$transaction([
      prisma.sendLog.deleteMany({
        where: {
          timestamp: { lt: cutoff },
          run: {
            status: { in: [RunStatus.COMPLETED, RunStatus.FAILED] }
          }
        }
      }),
      prisma.activityLog.deleteMany({
        where: {
          createdAt: { lt: cutoff }
        }
      })
    ])
  );

  if (sendLogs.count > 0 || activityLogs.count > 0) {
    await logActivity("retention", "Old logs cleaned up", "INFO", {
      cutoff: cutoff.toISOString(),
      sendLogsDeleted: sendLogs.count,
      activityLogsDeleted: activityLogs.count
    });
  }

  return {
    cutoff,
    sendLogsDeleted: sendLogs.count,
    activityLogsDeleted: activityLogs.count
  };
};

export const startLogRetentionWorker = () => {
  void cleanupOldLogs().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Log retention cleanup failed:", error);
  });

  return setInterval(() => {
    void cleanupOldLogs().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Log retention cleanup failed:", error);
    });
  }, RETENTION_INTERVAL_MS);
};
