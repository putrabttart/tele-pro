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
        completedCycles: 0
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
}

export const broadcastService = new BroadcastService();
