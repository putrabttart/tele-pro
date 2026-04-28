import { RunStatus, SendMode, SendStatus, TelegramConnectionStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { mtprotoSender } from "../telegram/mtproto-sender";
import { logActivity } from "../utils/logger";
import { randomInt, shuffle } from "../utils/random";
import { sleep } from "../utils/sleep";

const MODE_MARKER_PREFIX = "__TBM_MODE:";
const TEXT_MARKER_PREFIX = "__TBM_TEXT:";
const FORWARD_SOURCE_MARKER_PREFIX = "__TBM_FORWARD_SOURCE:";
const FORWARD_MESSAGE_MARKER_PREFIX = "__TBM_FORWARD_MESSAGE_ID:";

type ParsedRunPayload = {
  mode: SendMode;
  messageText?: string;
  forwardSourceChatId?: string;
  forwardMessageId?: number;
};

const markRunFailed = async (runId: string, message: string) => {
  await prisma.broadcastRun.update({
    where: { id: runId },
    data: {
      status: RunStatus.FAILED,
      reason: message,
      finishedAt: new Date()
    }
  });
};

const selectAccount = async (accountId?: string, currentRunId?: string) => {
  if (accountId) {
    return prisma.telegramAccount.findUnique({ where: { id: accountId } });
  }

  // Find account IDs that are currently used by other active runs
  const busyRuns = await prisma.broadcastRun.findMany({
    where: {
      status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] },
      requestedAccountId: { not: null },
      ...(currentRunId ? { id: { not: currentRunId } } : {})
    },
    select: { requestedAccountId: true }
  });
  const busyAccountIds = new Set(busyRuns.map((r) => r.requestedAccountId!));

  // Pick a connected account that is NOT busy with another run
  const candidates = await prisma.telegramAccount.findMany({
    where: { status: TelegramConnectionStatus.CONNECTED },
    orderBy: { updatedAt: "desc" }
  });

  return candidates.find((acc) => !busyAccountIds.has(acc.id)) ?? null;
};

const resolveGroupIdentifier = (group: { username: string | null; telegramId: string | null }) => {
  if (group.username) {
    return group.username.startsWith("@") ? group.username : `@${group.username}`;
  }

  if (group.telegramId) {
    return group.telegramId;
  }

  return null;
};

const parseRunPayload = (markers: string[]): ParsedRunPayload | null => {
  const modeMarker = markers.find((item) => item.startsWith(MODE_MARKER_PREFIX));
  if (!modeMarker) {
    return null;
  }

  const modeValue = modeMarker.slice(MODE_MARKER_PREFIX.length);

  if (modeValue === "DIRECT_TEXT") {
    const textMarker = markers.find((item) => item.startsWith(TEXT_MARKER_PREFIX));
    if (!textMarker) {
      return null;
    }

    try {
      const decodedText = Buffer.from(textMarker.slice(TEXT_MARKER_PREFIX.length), "base64")
        .toString("utf8")
        .trim();

      if (!decodedText) {
        return null;
      }

      return {
        mode: SendMode.NEW_MESSAGE,
        messageText: decodedText
      };
    } catch {
      return null;
    }
  }

  if (modeValue === "FORWARD_LINK") {
    const sourceMarker = markers.find((item) => item.startsWith(FORWARD_SOURCE_MARKER_PREFIX));
    if (!sourceMarker) {
      return null;
    }

    const forwardSourceChatId = sourceMarker.slice(FORWARD_SOURCE_MARKER_PREFIX.length).trim();
    if (!forwardSourceChatId) {
      return null;
    }

    const messageIdMarker = markers.find((item) => item.startsWith(FORWARD_MESSAGE_MARKER_PREFIX));
    const parsedMessageId = messageIdMarker
      ? Number(messageIdMarker.slice(FORWARD_MESSAGE_MARKER_PREFIX.length))
      : null;

    return {
      mode: SendMode.FORWARD,
      forwardSourceChatId,
      forwardMessageId:
        parsedMessageId && Number.isInteger(parsedMessageId) && parsedMessageId > 0
          ? parsedMessageId
          : undefined
    };
  }

  return null;
};

const processBroadcastRun = async (runId: string) => {
  // Peek at the current run to check if startedAt already exists (resume case)
  const existingRun = await prisma.broadcastRun.findUnique({
    where: { id: runId },
    select: { startedAt: true }
  });

  const claimed = await prisma.broadcastRun.updateMany({
    where: {
      id: runId,
      status: RunStatus.PENDING
    },
    data: {
      status: RunStatus.RUNNING,
      reason: null,
      // Only set startedAt on first start, never overwrite on resume
      ...(existingRun?.startedAt ? {} : { startedAt: new Date() })
    }
  });

  if (claimed.count === 0) {
    return;
  }

  const run = await prisma.broadcastRun.findUnique({
    where: { id: runId },
    include: {
      setting: true
    }
  });

  if (!run) {
    await logActivity("worker", "Run not found", "WARN", { runId });
    return;
  }

  if (run.status === RunStatus.COMPLETED) {
    return;
  }

  const account = await selectAccount(run.requestedAccountId ?? undefined, run.id);
  if (!account?.encryptedSession) {
    await markRunFailed(run.id, "No connected Telegram account/session");
    await logActivity("worker", "Run failed due to missing account", "ERROR", { runId: run.id });
    return;
  }

  const payload = parseRunPayload(run.requestedTemplateIds);
  const sendMode = payload?.mode ?? run.setting.sendMode;
  const directMessageText = payload?.messageText?.trim() ?? "";
  const forwardSourceChatId = payload?.forwardSourceChatId ?? run.setting.forwardSourceChatId;
  const forwardMessageId = payload?.forwardMessageId ?? run.setting.forwardMessageId ?? undefined;

  if (sendMode === SendMode.NEW_MESSAGE && !directMessageText) {
    await markRunFailed(run.id, "DIRECT_TEXT mode requires non-empty message text");
    await logActivity("worker", "Run failed due to missing DIRECT_TEXT payload", "ERROR", {
      runId: run.id
    });
    return;
  }

  if (sendMode === SendMode.FORWARD && !forwardSourceChatId) {
    await markRunFailed(run.id, "FORWARD mode requires forward source chat");
    await logActivity("worker", "Run failed due to incomplete FORWARD configuration", "ERROR", {
      runId: run.id
    });
    return;
  }

  const allGroups = await prisma.group.findMany({
    where: { isActive: true }
  });

  if (allGroups.length === 0) {
    await markRunFailed(run.id, "No active groups found");
    return;
  }

  const hasBatchInterval = run.totalDurationHours && run.intervalMinutes;

  // Use the original startedAt from DB so resume doesn't reset the clock
  const broadcastStartTime = run.startedAt ? run.startedAt.getTime() : Date.now();
  const totalDurationMs = hasBatchInterval ? run.totalDurationHours! * 60 * 60 * 1000 : 0;
  const intervalMs = hasBatchInterval ? run.intervalMinutes! * 60 * 1000 : 0;

  // Also enforce a hard cap: max cycles = floor(totalDurationHours * 60 / intervalMinutes)
  const maxCycles = hasBatchInterval
    ? Math.floor((run.totalDurationHours! * 60) / run.intervalMinutes!)
    : Infinity;

  let sentCount = 0;
  let failedCount = 0;
  let completedCycles = run.completedCycles ?? 0;

  const sendOneCycle = async (): Promise<"ok" | "paused"> => {
    // Skip groups that were already successfully sent in this run (resume-safe)
    const alreadySent = await prisma.sendLog.findMany({
      where: { runId: run.id, status: SendStatus.SUCCESS },
      select: { groupId: true }
    });
    const sentGroupIds = new Set(alreadySent.map((log) => log.groupId));

    const remainingGroups = allGroups.filter((g) => !sentGroupIds.has(g.id));
    const groups = run.setting.randomizeGroups ? shuffle([...remainingGroups]) : [...remainingGroups];
    let pendingCount = groups.length;

    if (sentGroupIds.size > 0) {
      // Resuming — carry over previous counts
      sentCount = Math.max(sentCount, alreadySent.length);
      await logActivity("worker", "Resuming cycle — skipping already-sent groups", "INFO", {
        runId: run.id,
        alreadySent: sentGroupIds.size,
        remaining: groups.length
      });
    }

    await prisma.broadcastRun.update({
      where: { id: run.id },
      data: {
        totalGroups: allGroups.length,
        pendingCount: groups.length,
        reason: null
      }
    });

    for (let start = 0; start < groups.length; ) {
      const currentRun = await prisma.broadcastRun.findUnique({ where: { id: run.id } });
      if (!currentRun || currentRun.status === RunStatus.PAUSED) {
        await logActivity("worker", "Run paused while processing", "WARN", { runId: run.id });
        return "paused";
      }

      const batchSizeMin = Math.max(1, run.setting.batchSizeMin);
      const batchSizeMax = Math.max(batchSizeMin, run.setting.batchSizeMax);
      const batchSize = randomInt(batchSizeMin, batchSizeMax);
      const batch = groups.slice(start, start + batchSize);

      for (const group of batch) {
        const text = sendMode === SendMode.NEW_MESSAGE ? directMessageText : "";

        const messageDelayMin = Math.max(1, run.setting.messageDelayMinSec);
        const messageDelayMax = Math.max(messageDelayMin, run.setting.messageDelayMaxSec);
        const messageDelayMs = Math.max(
          randomInt(messageDelayMin, messageDelayMax) * 1000,
          env.MIN_SPACING_MS
        );

        await sleep(messageDelayMs);

        const groupIdentifier = resolveGroupIdentifier(group);
        if (!groupIdentifier) {
          failedCount += 1;
          pendingCount -= 1;

          await prisma.sendLog.create({
            data: {
              runId: run.id,
              groupId: group.id,
              accountId: account.id,
              status: SendStatus.FAILED,
              errorCode: "GROUP_IDENTIFIER_MISSING",
              errorMessage: "Group has no username or telegramId"
            }
          });

          await prisma.broadcastRun.update({
            where: { id: run.id },
            data: {
              failedCount,
              pendingCount,
              sentCount
            }
          });

          continue;
        }

        const sendResult = await mtprotoSender.sendToGroup({
          encryptedSession: account.encryptedSession!,
          groupIdentifier,
          sendMode,
          text,
          mediaUrl: undefined,
          forwardSourceChatId,
          forwardMessageId
        });

        if (sendResult.ok) {
          sentCount += 1;

          await prisma.sendLog.create({
            data: {
              runId: run.id,
              groupId: group.id,
              accountId: account.id,
              status: SendStatus.SUCCESS
            }
          });
        } else {
          failedCount += 1;

          await prisma.sendLog.create({
            data: {
              runId: run.id,
              groupId: group.id,
              accountId: account.id,
              status: SendStatus.FAILED,
              errorCode: sendResult.errorCode,
              errorMessage: sendResult.errorMessage
            }
          });

          if (run.setting.autoPauseOnLimit && sendResult.errorCode === "FLOOD_WAIT" && sendResult.floodWaitSeconds) {
            const pauseUntil = new Date(Date.now() + sendResult.floodWaitSeconds * 1000);

            await prisma.broadcastRun.update({
              where: { id: run.id },
              data: {
                status: RunStatus.PAUSED,
                reason: `FloodWait detected: ${sendResult.floodWaitSeconds}s`,
                pausedUntil: pauseUntil,
                sentCount,
                failedCount,
                pendingCount: pendingCount - 1,
                completedCycles
              }
            });

            await logActivity("worker", "Run auto-paused by FloodWait", "WARN", {
              runId: run.id,
              pauseSeconds: sendResult.floodWaitSeconds
            });

            return "paused";
          }

          if (run.setting.autoPauseOnLimit && sendResult.errorCode === "PEER_FLOOD") {
            await prisma.broadcastRun.update({
              where: { id: run.id },
              data: {
                status: RunStatus.PAUSED,
                reason: "PeerFlood detected",
                sentCount,
                failedCount,
                pendingCount: pendingCount - 1,
                completedCycles
              }
            });

            await logActivity("worker", "Run paused by PeerFlood", "WARN", {
              runId: run.id
            });

            return "paused";
          }
        }

        pendingCount -= 1;

        await prisma.broadcastRun.update({
          where: { id: run.id },
          data: {
            sentCount,
            failedCount,
            pendingCount
          }
        });
      }

      start += batch.length;

      if (start < groups.length) {
        const batchDelayMin = Math.max(0, run.setting.batchDelayMinMin);
        const batchDelayMax = Math.max(batchDelayMin, run.setting.batchDelayMaxMin);
        const delayMs = randomInt(batchDelayMin, batchDelayMax) * 60 * 1000;
        await sleep(delayMs);
      }
    }

    return "ok";
  };

  if (hasBatchInterval) {
    // ── Batch Interval Mode ──
    // Send to all groups, wait interval, repeat until total duration expires
    await logActivity("worker", "Batch interval broadcast started", "INFO", {
      runId: run.id,
      totalDurationHours: run.totalDurationHours,
      intervalMinutes: run.intervalMinutes
    });

    while (true) {
      // Hard cap: never exceed max cycles regardless of timing
      if (completedCycles >= maxCycles) {
        await logActivity("worker", "Batch interval max cycles reached", "INFO", {
          runId: run.id,
          completedCycles,
          maxCycles
        });
        break;
      }

      const elapsed = Date.now() - broadcastStartTime;
      if (elapsed >= totalDurationMs) {
        await logActivity("worker", "Batch interval duration expired", "INFO", {
          runId: run.id,
          completedCycles
        });
        break;
      }

      // Check if run is still running (not paused/cancelled externally)
      const currentRun = await prisma.broadcastRun.findUnique({ where: { id: run.id } });
      if (!currentRun || currentRun.status === RunStatus.PAUSED || currentRun.status === RunStatus.FAILED) {
        await logActivity("worker", "Batch interval run stopped externally", "WARN", { runId: run.id });
        return;
      }

      const cycleResult = await sendOneCycle();
      if (cycleResult === "paused") {
        return;
      }

      completedCycles += 1;

      // Check if this was the last cycle (hard cap)
      const isLastCycle = completedCycles >= maxCycles;

      if (isLastCycle) {
        await prisma.broadcastRun.update({
          where: { id: run.id },
          data: {
            completedCycles,
            sentCount,
            failedCount,
            reason: `Semua ${completedCycles} siklus selesai.`
          }
        });

        await logActivity("worker", `All ${completedCycles}/${maxCycles} cycles completed`, "INFO", {
          runId: run.id,
          sentCount,
          failedCount,
          completedCycles,
          maxCycles
        });

        break;
      }

      await prisma.broadcastRun.update({
        where: { id: run.id },
        data: {
          completedCycles,
          sentCount,
          failedCount,
          reason: `Cycle ${completedCycles}/${maxCycles} completed. Waiting ${run.intervalMinutes} min for next cycle...`
        }
      });

      await logActivity("worker", `Cycle ${completedCycles}/${maxCycles} completed`, "INFO", {
        runId: run.id,
        sentCount,
        failedCount,
        completedCycles,
        maxCycles
      });

      // Check if duration will expire before next interval
      const elapsedAfterCycle = Date.now() - broadcastStartTime;
      if (elapsedAfterCycle + intervalMs > totalDurationMs) {
        await logActivity("worker", "Not enough time for next cycle, finishing", "INFO", {
          runId: run.id,
          completedCycles
        });
        break;
      }

      // Wait for the interval before next cycle, checking for pause/cancel every 10s
      const intervalCheckMs = 10_000;
      let waitedMs = 0;
      let aborted = false;
      while (waitedMs < intervalMs) {
        const sleepChunk = Math.min(intervalCheckMs, intervalMs - waitedMs);
        await sleep(sleepChunk);
        waitedMs += sleepChunk;

        // Check if run was paused or cancelled (status changed to FAILED) during wait
        const checkRun = await prisma.broadcastRun.findUnique({ where: { id: run.id } });
        if (!checkRun || checkRun.status === RunStatus.PAUSED || checkRun.status === RunStatus.FAILED) {
          aborted = true;
          break;
        }
      }

      if (aborted) {
        await logActivity("worker", "Batch interval run aborted during wait", "WARN", { runId: run.id });
        return;
      }
    }
  } else {
    // ── Single Run Mode (legacy) ──
    const cycleResult = await sendOneCycle();
    if (cycleResult === "paused") {
      return;
    }
    completedCycles = 1;
  }

  await prisma.broadcastRun.update({
    where: { id: run.id },
    data: {
      status: RunStatus.COMPLETED,
      finishedAt: new Date(),
      sentCount,
      failedCount,
      pendingCount: 0,
      completedCycles
    }
  });

  await logActivity("worker", "Run completed", "INFO", {
    runId: run.id,
    sentCount,
    failedCount,
    completedCycles
  });
};

const resumeDuePausedRuns = async () => {
  await prisma.broadcastRun.updateMany({
    where: {
      status: RunStatus.PAUSED,
      pausedUntil: {
        lte: new Date()
      }
    },
    data: {
      status: RunStatus.PENDING,
      pausedUntil: null,
      reason: null
    }
  });
};

/**
 * Recover runs that were stuck as RUNNING when the server crashed.
 * Any run that has been RUNNING but not updated in the last 5 minutes
 * is considered orphaned and gets reset to PENDING so it can resume.
 */
const STALE_RUN_THRESHOLD_MS = 5 * 60 * 1000;

const recoverStaleRunningRuns = async () => {
  const staleThreshold = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);

  const staleRuns = await prisma.broadcastRun.findMany({
    where: {
      status: RunStatus.RUNNING,
      updatedAt: { lte: staleThreshold }
    },
    select: { id: true, sentCount: true, failedCount: true, completedCycles: true }
  });

  if (staleRuns.length === 0) return;

  for (const stale of staleRuns) {
    await prisma.broadcastRun.update({
      where: { id: stale.id },
      data: {
        status: RunStatus.PENDING,
        reason: `Auto-recovered: server restart terdeteksi. Melanjutkan dari ${stale.sentCount} terkirim, ${stale.failedCount} gagal (cycle ${stale.completedCycles}).`
      }
    });

    await logActivity("worker", "Recovered stale RUNNING run", "WARN", {
      runId: stale.id,
      sentCount: stale.sentCount,
      failedCount: stale.failedCount,
      completedCycles: stale.completedCycles
    });
  }
};

/** Set of run IDs currently being processed (supports concurrent runs) */
const activeRunIds = new Set<string>();
let tickLock = false;

const processTick = async () => {
  // Prevent overlapping ticks (but NOT blocking while runs execute)
  if (tickLock) return;
  tickLock = true;

  try {
    await recoverStaleRunningRuns();
    await resumeDuePausedRuns();

    // Find ALL pending runs, not just one
    const pendingRuns = await prisma.broadcastRun.findMany({
      where: {
        status: RunStatus.PENDING
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    for (const pending of pendingRuns) {
      // Skip if this run is already being processed in-memory
      if (activeRunIds.has(pending.id)) continue;

      activeRunIds.add(pending.id);

      // Fire-and-forget: run concurrently, don't await
      void (async () => {
        try {
          await processBroadcastRun(pending.id);
        } catch (error) {
          await logActivity("worker", "Broadcast run failed unexpectedly", "ERROR", {
            runId: pending.id,
            message: error instanceof Error ? error.message : "Unknown error"
          });
        } finally {
          activeRunIds.delete(pending.id);
        }
      })();
    }
  } catch (error) {
    await logActivity("worker", "Broadcast tick failed", "ERROR", {
      message: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    tickLock = false;
  }
};

/**
 * Graceful shutdown: pause all running runs so they can be resumed later.
 */
const gracefulShutdown = async () => {
  try {
    await prisma.broadcastRun.updateMany({
      where: { status: RunStatus.RUNNING },
      data: {
        status: RunStatus.PENDING,
        reason: "Server shutdown — broadcast akan otomatis dilanjutkan saat server nyala kembali."
      }
    });
  } catch {
    // DB might already be disconnected
  }
};

export const startBroadcastWorker = () => {
  void processTick();
  return setInterval(() => {
    void processTick();
  }, env.RUN_POLL_INTERVAL_MS);
};

export { gracefulShutdown };
