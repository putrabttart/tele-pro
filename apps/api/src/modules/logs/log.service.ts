import { SendStatus } from "@prisma/client";
import { stringify } from "csv-stringify/sync";
import { prisma } from "../../config/prisma";

const DEFAULT_SEND_LOG_LIMIT = 120;
const MAX_SEND_LOG_LIMIT = 200;
const MAX_EXPORT_LOG_LIMIT = 5000;

type ListSendLogsParams = {
  status?: SendStatus;
  runId?: string;
  cycleNumber?: number;
  from?: Date;
  to?: Date;
  limit?: number;
};

const clampLimit = (value: number | undefined, fallback: number, max: number) => {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
};

class LogService {
  async listSendLogs(params?: ListSendLogsParams) {
    const where: Record<string, unknown> = {};

    if (params?.status) where.status = params.status;
    if (params?.runId) where.runId = params.runId;
    if (params?.cycleNumber !== undefined) where.cycleNumber = params.cycleNumber;
    if (params?.from || params?.to) {
      where.timestamp = {
        ...(params.from ? { gte: params.from } : {}),
        ...(params.to ? { lte: params.to } : {})
      };
    }

    return prisma.sendLog.findMany({
      where,
      select: {
        id: true,
        runId: true,
        cycleNumber: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        timestamp: true,
        group: {
          select: {
            username: true,
            telegramId: true,
            title: true
          }
        },
        account: {
          select: {
            id: true,
            label: true,
            phone: true
          }
        },
        run: {
          select: {
            id: true,
            label: true,
            status: true,
            requestedAccountId: true,
            completedCycles: true,
            totalDurationHours: true,
            intervalMinutes: true,
            createdAt: true
          }
        }
      },
      orderBy: {
        timestamp: "desc"
      },
      take: clampLimit(params?.limit, DEFAULT_SEND_LOG_LIMIT, MAX_SEND_LOG_LIMIT)
    });
  }

  async listActivityLogs(params?: { runId?: string; module?: string }) {
    const where: Record<string, unknown> = {};

    if (params?.module) where.module = params.module;

    // If runId is provided, filter activity logs that contain this runId in meta
    if (params?.runId) {
      where.meta = {
        path: ["runId"],
        equals: params.runId
      };
    }

    return prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500
    });
  }

  /**
   * Get send log summary per cycle for a specific run
   */
  async getCycleSummary(runId: string) {
    // Get the run with cycle details
    const run = await prisma.broadcastRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        completedCycles: true,
        currentCycleNumber: true,
        totalDurationHours: true,
        intervalMinutes: true,
        cycleDetails: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        sentCount: true,
        failedCount: true,
        totalGroups: true,
        currentCycleStartedAt: true,
        lastCycleFinishedAt: true,
        nextCycleAt: true,
        consecutiveFailCount: true,
        reason: true
      }
    });

    if (!run) return null;

    // Get per-cycle stats from SendLog
    const cycleStats = await prisma.$queryRaw<
      Array<{
        cycleNumber: number;
        total: bigint;
        success: bigint;
        failed: bigint;
        firstSent: Date | null;
        lastSent: Date | null;
      }>
    >`
      SELECT 
        "cycleNumber",
        COUNT(*)::bigint as total,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')::bigint as success,
        COUNT(*) FILTER (WHERE status = 'FAILED')::bigint as failed,
        MIN(timestamp) as "firstSent",
        MAX(timestamp) as "lastSent"
      FROM "SendLog"
      WHERE "runId" = ${runId}
      GROUP BY "cycleNumber"
      ORDER BY "cycleNumber" ASC
    `;

    const cycles = cycleStats.map((stat) => ({
      cycleNumber: stat.cycleNumber,
      total: Number(stat.total),
      success: Number(stat.success),
      failed: Number(stat.failed),
      firstSent: stat.firstSent,
      lastSent: stat.lastSent,
      durationMs: stat.firstSent && stat.lastSent
        ? new Date(stat.lastSent).getTime() - new Date(stat.firstSent).getTime()
        : null
    }));

    return {
      run: {
        id: run.id,
        status: run.status,
        completedCycles: run.completedCycles,
        currentCycleNumber: run.currentCycleNumber,
        totalDurationHours: run.totalDurationHours,
        intervalMinutes: run.intervalMinutes,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        sentCount: run.sentCount,
        failedCount: run.failedCount,
        totalGroups: run.totalGroups,
        currentCycleStartedAt: run.currentCycleStartedAt,
        lastCycleFinishedAt: run.lastCycleFinishedAt,
        nextCycleAt: run.nextCycleAt,
        consecutiveFailCount: run.consecutiveFailCount,
        reason: run.reason,
        cycleDetails: run.cycleDetails
      },
      cycles
    };
  }

  /**
   * Get send logs for a specific run and cycle
   */
  async getLogsForCycle(runId: string, cycleNumber: number, limit?: number) {
    return prisma.sendLog.findMany({
      where: {
        runId,
        cycleNumber
      },
      select: {
        id: true,
        runId: true,
        cycleNumber: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        timestamp: true,
        group: {
          select: {
            username: true,
            telegramId: true,
            title: true
          }
        },
        account: {
          select: {
            id: true,
            label: true,
            phone: true
          }
        }
      },
      orderBy: {
        timestamp: "asc"
      },
      take: clampLimit(limit, DEFAULT_SEND_LOG_LIMIT, MAX_SEND_LOG_LIMIT)
    });
  }

  /**
   * Get failure analysis for a run — grouped by error code
   */
  async getFailureAnalysis(runId: string) {
    const failures = await prisma.$queryRaw<
      Array<{
        errorCode: string | null;
        errorMessage: string | null;
        cycleNumber: number;
        count: bigint;
      }>
    >`
      SELECT 
        "errorCode",
        "errorMessage",
        "cycleNumber",
        COUNT(*)::bigint as count
      FROM "SendLog"
      WHERE "runId" = ${runId} AND status = 'FAILED'
      GROUP BY "errorCode", "errorMessage", "cycleNumber"
      ORDER BY "cycleNumber" ASC, count DESC
    `;

    return failures.map((f) => ({
      errorCode: f.errorCode,
      errorMessage: f.errorMessage,
      cycleNumber: f.cycleNumber,
      count: Number(f.count)
    }));
  }

  async exportSendLogsCsv(params?: ListSendLogsParams) {
    const logs = await this.listSendLogs({
      ...params,
      limit: clampLimit(params?.limit, MAX_EXPORT_LOG_LIMIT, MAX_EXPORT_LOG_LIMIT)
    });

    const rows = logs.map((log) => ({
      id: log.id,
      runId: log.runId,
      cycleNumber: log.cycleNumber,
      group: log.group.username ?? log.group.telegramId ?? "unknown",
      account: log.account?.phone ?? "n/a",
      status: log.status,
      errorCode: log.errorCode ?? "",
      errorMessage: log.errorMessage ?? "",
      timestamp: log.timestamp.toISOString()
    }));

    return stringify(rows, {
      header: true
    });
  }
}

export const logService = new LogService();
