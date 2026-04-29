import { RunStatus, SendMode } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/api-error";
import { logActivity } from "../../utils/logger";
import { parseForwardMessageLink, parseForwardSourceLink } from "../../utils/telegram-links";

const MODE_MARKER_PREFIX = "__TBM_MODE:";
const TEXT_MARKER_PREFIX = "__TBM_TEXT:";
const FORWARD_SOURCE_MARKER_PREFIX = "__TBM_FORWARD_SOURCE:";
const FORWARD_MESSAGE_MARKER_PREFIX = "__TBM_FORWARD_MESSAGE_ID:";

type CreateRunPayload = {
  label?: string;
  settingId?: string;
  scheduleId?: string;
  accountId?: string;
  mode?: "DIRECT_TEXT" | "FORWARD_LINK";
  messageText?: string;
  messageLink?: string;
  totalDurationHours?: number;
  intervalMinutes?: number;
};

class BroadcastService {
  async createRun(payload: CreateRunPayload) {
    const setting = payload.settingId
      ? await prisma.broadcastSetting.findUnique({ where: { id: payload.settingId } })
      : await prisma.broadcastSetting.findFirst({ where: { isActive: true } });

    if (!setting) {
      throw new ApiError(400, "No broadcast setting found");
    }

    // ── Check if the requested account is already busy with an active run ──
    if (payload.accountId) {
      const busyRun = await prisma.broadcastRun.findFirst({
        where: {
          requestedAccountId: payload.accountId,
          status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] }
        }
      });

      if (busyRun) {
        throw new ApiError(400, `Akun ini sedang digunakan oleh broadcast "${busyRun.label || busyRun.id.slice(0, 8)}" (${busyRun.status}). Tunggu sampai selesai atau hentikan broadcast tersebut.`);
      }
    }

    // ── Also check if any auto-selected account would conflict ──
    // If no specific account requested, check if there's already a run without specific account
    // that is active (to prevent the worker from picking the same account)

    let requestedTemplateIds: string[] = [];
    let effectiveMode = setting.sendMode;

    if (payload.mode === "DIRECT_TEXT") {
      const messageText = payload.messageText?.trim();
      if (!messageText) {
        throw new ApiError(400, "messageText is required for DIRECT_TEXT mode");
      }

      requestedTemplateIds = [
        `${MODE_MARKER_PREFIX}DIRECT_TEXT`,
        `${TEXT_MARKER_PREFIX}${Buffer.from(messageText, "utf8").toString("base64")}`
      ];
      effectiveMode = SendMode.NEW_MESSAGE;
    }

    if (payload.mode === "FORWARD_LINK") {
      const messageLink = payload.messageLink?.trim();
      if (!messageLink) {
        throw new ApiError(400, "messageLink is required for FORWARD_LINK mode");
      }

      const parsedFromMessageLink = parseForwardMessageLink(messageLink);
      const parsedSource = parsedFromMessageLink
        ? { forwardSourceChatId: parsedFromMessageLink.forwardSourceChatId }
        : parseForwardSourceLink(messageLink);

      if (!parsedSource) {
        throw new ApiError(400, "Invalid Telegram link. Use message link or channel/source link");
      }

      requestedTemplateIds = [
        `${MODE_MARKER_PREFIX}FORWARD_LINK`,
        `${FORWARD_SOURCE_MARKER_PREFIX}${parsedSource.forwardSourceChatId}`
      ];

      if (parsedFromMessageLink?.forwardMessageId) {
        requestedTemplateIds.push(`${FORWARD_MESSAGE_MARKER_PREFIX}${parsedFromMessageLink.forwardMessageId}`);
      }

      effectiveMode = SendMode.FORWARD;
    }

    if (!payload.mode && setting.sendMode === SendMode.FORWARD && !setting.forwardSourceChatId) {
      throw new ApiError(400, "Active setting FORWARD mode requires forward source configuration");
    }

    // Validasi: interval terlalu kecil bisa menyebabkan terlalu banyak siklus
    if (payload.totalDurationHours && payload.intervalMinutes) {
      const estimatedCycles = Math.floor((payload.totalDurationHours * 60) / payload.intervalMinutes);
      if (estimatedCycles > 500) {
        throw new ApiError(400, `Terlalu banyak siklus (${estimatedCycles}x). Periksa interval — nilai dalam MENIT (contoh: 1 jam = 60 menit). Maksimal 500 siklus.`);
      }
      if (payload.intervalMinutes < 5) {
        throw new ApiError(400, `Interval terlalu kecil (${payload.intervalMinutes} menit). Minimum interval adalah 5 menit untuk menghindari spam.`);
      }
    }

    const run = await prisma.broadcastRun.create({
      data: {
        label: payload.label?.trim() || null,
        settingId: setting.id,
        scheduleId: payload.scheduleId,
        requestedAccountId: payload.accountId,
        requestedTemplateIds,
        status: RunStatus.PENDING,
        totalDurationHours: payload.totalDurationHours ?? null,
        intervalMinutes: payload.intervalMinutes ?? null,
        completedCycles: 0,
        currentCycleNumber: 0,
        consecutiveFailCount: 0,
        cycleDetails: []
      }
    });

    await logActivity("broadcast", "Broadcast run created as pending", "INFO", {
      runId: run.id,
      settingId: setting.id,
      mode: effectiveMode
    });

    return run;
  }

  async listRuns() {
    return prisma.broadcastRun.findMany({
      include: {
        schedule: true,
        setting: true
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 100
    });
  }

  async getRunDetail(runId: string) {
    const run = await prisma.broadcastRun.findUnique({
      where: { id: runId },
      include: {
        schedule: true,
        setting: true
      }
    });

    if (!run) {
      throw new ApiError(404, "Run not found");
    }

    // Get per-cycle counts
    const cycleCounts = await prisma.sendLog.groupBy({
      by: ["cycleNumber", "status"],
      where: { runId },
      _count: true
    });

    // Build cycle summary map
    const cycleMap = new Map<number, { success: number; failed: number; total: number }>();
    for (const row of cycleCounts) {
      const existing = cycleMap.get(row.cycleNumber) ?? { success: 0, failed: 0, total: 0 };
      if (row.status === "SUCCESS") existing.success = row._count;
      else if (row.status === "FAILED") existing.failed = row._count;
      existing.total += row._count;
      cycleMap.set(row.cycleNumber, existing);
    }

    return {
      ...run,
      cycleSummary: Array.from(cycleMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([cycleNumber, stats]) => ({ cycleNumber, ...stats }))
    };
  }

  /** Get list of account IDs that are currently busy (used in active runs) */
  async getBusyAccountIds() {
    const activeRuns = await prisma.broadcastRun.findMany({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] },
        requestedAccountId: { not: null }
      },
      select: {
        requestedAccountId: true,
        id: true,
        label: true,
        status: true
      }
    });

    return activeRuns.map((run) => ({
      accountId: run.requestedAccountId!,
      runId: run.id,
      runLabel: run.label,
      runStatus: run.status
    }));
  }

  async pauseRun(runId: string, reason = "Paused by user") {
    return prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.PAUSED,
        reason
      }
    });
  }

  async resumeRun(runId: string) {
    return prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.PENDING,
        reason: null,
        pausedUntil: null
      }
    });
  }

  async cancelRun(runId: string) {
    const run = await prisma.broadcastRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new ApiError(404, "Run not found");
    }

    if (run.status === "COMPLETED" || run.status === "FAILED") {
      throw new ApiError(400, "Cannot cancel a run that is already completed or failed");
    }

    return prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.FAILED,
        reason: "Dihentikan oleh user",
        finishedAt: new Date()
      }
    });
  }
}

export const broadcastService = new BroadcastService();
