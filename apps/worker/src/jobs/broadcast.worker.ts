import { RunStatus, SendMode, SendStatus, TelegramConnectionStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { mtprotoSender } from "../telegram/mtproto-sender";
import { logActivity } from "../utils/logger";
import { randomInt, shuffle } from "../utils/random";
import { sleep } from "../utils/sleep";

// ═══════════════════════════════════════════════════════════
// CONSTANTS & MARKERS
// ═══════════════════════════════════════════════════════════

const MODE_MARKER_PREFIX = "__TBM_MODE:";
const TEXT_MARKER_PREFIX = "__TBM_TEXT:";
const FORWARD_SOURCE_MARKER_PREFIX = "__TBM_FORWARD_SOURCE:";
const FORWARD_MESSAGE_MARKER_PREFIX = "__TBM_FORWARD_MESSAGE_ID:";

// Anti-spam protection constants
const MAX_CONSECUTIVE_FAILS = 10; // Max consecutive fails before auto-pause
const COOLDOWN_AFTER_CYCLE_MS = 5_000; // 5s cooldown between cycles (minimum)
const STALE_RUN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const INTERVAL_CHECK_MS = 10_000; // Check every 10s during interval wait

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

type ParsedRunPayload = {
  mode: SendMode;
  messageText?: string;
  forwardSourceChatId?: string;
  forwardMessageId?: number;
};

type CycleResult = {
  status: "ok" | "paused" | "failed" | "cancelled";
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failReason?: string;
};

type CycleDetail = {
  cycleNumber: number;
  status: "completed" | "paused" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sent: number;
  failed: number;
  skipped: number;
  failReason?: string;
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

const markRunFailed = async (runId: string, message: string) => {
  await prisma.broadcastRun.update({
    where: { id: runId },
    data: {
      status: RunStatus.FAILED,
      reason: message,
      finishedAt: new Date()
    }
  });

  await logActivity("worker", `Run FAILED: ${message}`, "ERROR", { runId, reason: message });
};

const selectAccount = async (accountId?: string, currentRunId?: string) => {
  if (accountId) {
    return prisma.telegramAccount.findUnique({ where: { id: accountId } });
  }

  const busyRuns = await prisma.broadcastRun.findMany({
    where: {
      status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] },
      requestedAccountId: { not: null },
      ...(currentRunId ? { id: { not: currentRunId } } : {})
    },
    select: { requestedAccountId: true }
  });
  const busyAccountIds = new Set(busyRuns.map((r) => r.requestedAccountId!));

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
  if (!modeMarker) return null;

  const modeValue = modeMarker.slice(MODE_MARKER_PREFIX.length);

  if (modeValue === "DIRECT_TEXT") {
    const textMarker = markers.find((item) => item.startsWith(TEXT_MARKER_PREFIX));
    if (!textMarker) return null;

    try {
      const decodedText = Buffer.from(textMarker.slice(TEXT_MARKER_PREFIX.length), "base64")
        .toString("utf8")
        .trim();
      if (!decodedText) return null;
      return { mode: SendMode.NEW_MESSAGE, messageText: decodedText };
    } catch {
      return null;
    }
  }

  if (modeValue === "FORWARD_LINK") {
    const sourceMarker = markers.find((item) => item.startsWith(FORWARD_SOURCE_MARKER_PREFIX));
    if (!sourceMarker) return null;

    const forwardSourceChatId = sourceMarker.slice(FORWARD_SOURCE_MARKER_PREFIX.length).trim();
    if (!forwardSourceChatId) return null;

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

/**
 * Check if run is still active (not paused/cancelled/failed externally)
 */
const isRunStillActive = async (runId: string): Promise<boolean> => {
  const run = await prisma.broadcastRun.findUnique({
    where: { id: runId },
    select: { status: true }
  });
  return run?.status === RunStatus.RUNNING;
};

// ═══════════════════════════════════════════════════════════
// CORE: SEND ONE CYCLE
// ═══════════════════════════════════════════════════════════

/**
 * Execute one complete cycle of sending to all groups.
 * 
 * KEY FIX: cycleNumber parameter ensures SendLog deduplication is per-cycle,
 * not across all cycles. This was the root cause of cycles 2+ failing.
 */
const sendOneCycle = async (params: {
  runId: string;
  cycleNumber: number;
  accountId: string;
  encryptedSession: string;
  sendMode: SendMode;
  messageText: string;
  forwardSourceChatId?: string | null;
  forwardMessageId?: number;
  setting: {
    batchSizeMin: number;
    batchSizeMax: number;
    messageDelayMinSec: number;
    messageDelayMaxSec: number;
    batchDelayMinMin: number;
    batchDelayMaxMin: number;
    randomizeGroups: boolean;
    autoPauseOnLimit: boolean;
  };
  allGroups: Array<{ id: string; username: string | null; telegramId: string | null }>;
}): Promise<CycleResult> => {
  const cycleStartTime = Date.now();
  let cycleSent = 0;
  let cycleFailed = 0;
  let cycleSkipped = 0;
  let consecutiveFails = 0;

  const { runId, cycleNumber, setting, allGroups } = params;

  // Update run: mark current cycle start
  await prisma.broadcastRun.update({
    where: { id: runId },
    data: {
      currentCycleStartedAt: new Date(),
      currentCycleNumber: cycleNumber,
      reason: `Siklus ${cycleNumber} sedang berjalan...`
    }
  });

  await logActivity("worker", `Siklus ${cycleNumber} DIMULAI`, "INFO", {
    runId,
    cycleNumber,
    totalGroups: allGroups.length,
    startTime: new Date().toISOString()
  });

  // ═══ KEY FIX: Only skip groups already sent IN THIS SPECIFIC CYCLE ═══
  // Previously this queried ALL success logs for the run (no cycle filter),
  // causing cycle 2+ to see all groups as "already sent"
  const alreadySentInThisCycle = await prisma.sendLog.findMany({
    where: {
      runId,
      cycleNumber, // ← THIS IS THE FIX
      status: SendStatus.SUCCESS
    },
    select: { groupId: true }
  });
  const sentGroupIds = new Set(alreadySentInThisCycle.map((log) => log.groupId));

  const remainingGroups = allGroups.filter((g) => !sentGroupIds.has(g.id));
  const groups = setting.randomizeGroups ? shuffle([...remainingGroups]) : [...remainingGroups];

  if (sentGroupIds.size > 0) {
    await logActivity("worker", `Siklus ${cycleNumber}: Resume - skip ${sentGroupIds.size} group yang sudah terkirim`, "INFO", {
      runId,
      cycleNumber,
      alreadySent: sentGroupIds.size,
      remaining: groups.length
    });
    cycleSent = sentGroupIds.size;
  }

  let pendingCount = groups.length;

  await prisma.broadcastRun.update({
    where: { id: runId },
    data: {
      totalGroups: allGroups.length,
      pendingCount: groups.length,
      reason: `Siklus ${cycleNumber}: Mengirim ke ${groups.length} grup...`
    }
  });

  // Process groups in batches
  for (let start = 0; start < groups.length;) {
    // Check if run is still active
    if (!(await isRunStillActive(runId))) {
      await logActivity("worker", `Siklus ${cycleNumber}: Run di-pause/cancel saat proses`, "WARN", {
        runId,
        cycleNumber,
        sentSoFar: cycleSent,
        failedSoFar: cycleFailed
      });
      return {
        status: "paused",
        sent: cycleSent,
        failed: cycleFailed,
        skipped: cycleSkipped,
        durationMs: Date.now() - cycleStartTime,
        failReason: "Run paused/cancelled externally"
      };
    }

    // Anti-spam: Check consecutive fail limit
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      const reason = `Anti-spam: ${MAX_CONSECUTIVE_FAILS} kegagalan berturut-turut di siklus ${cycleNumber}`;
      await prisma.broadcastRun.update({
        where: { id: runId },
        data: {
          status: RunStatus.PAUSED,
          reason,
          consecutiveFailCount: consecutiveFails
        }
      });

      await logActivity("worker", `Siklus ${cycleNumber}: AUTO-PAUSE karena ${MAX_CONSECUTIVE_FAILS} gagal berturut`, "ERROR", {
        runId,
        cycleNumber,
        consecutiveFails,
        cycleSent,
        cycleFailed
      });

      return {
        status: "failed",
        sent: cycleSent,
        failed: cycleFailed,
        skipped: groups.length - start - (cycleSent + cycleFailed - sentGroupIds.size),
        durationMs: Date.now() - cycleStartTime,
        failReason: reason
      };
    }

    // Determine batch size
    const batchSizeMin = Math.max(1, setting.batchSizeMin);
    const batchSizeMax = Math.max(batchSizeMin, setting.batchSizeMax);
    const batchSize = randomInt(batchSizeMin, batchSizeMax);
    const batch = groups.slice(start, start + batchSize);

    // Process each group in batch
    for (const group of batch) {
      // Re-check run status before each send (lightweight)
      if (!(await isRunStillActive(runId))) {
        return {
          status: "paused",
          sent: cycleSent,
          failed: cycleFailed,
          skipped: cycleSkipped,
          durationMs: Date.now() - cycleStartTime,
          failReason: "Run paused/cancelled mid-batch"
        };
      }

      const text = params.sendMode === SendMode.NEW_MESSAGE ? params.messageText : "";

      // Random delay between messages (anti-spam)
      const messageDelayMin = Math.max(1, setting.messageDelayMinSec);
      const messageDelayMax = Math.max(messageDelayMin, setting.messageDelayMaxSec);
      const messageDelayMs = Math.max(
        randomInt(messageDelayMin, messageDelayMax) * 1000,
        env.MIN_SPACING_MS
      );
      await sleep(messageDelayMs);

      const groupIdentifier = resolveGroupIdentifier(group);
      if (!groupIdentifier) {
        cycleFailed += 1;
        pendingCount -= 1;
        cycleSkipped += 1;
        consecutiveFails += 1;

        await prisma.sendLog.create({
          data: {
            runId,
            groupId: group.id,
            accountId: params.accountId,
            cycleNumber,
            status: SendStatus.FAILED,
            errorCode: "GROUP_IDENTIFIER_MISSING",
            errorMessage: "Group has no username or telegramId"
          }
        });

        await prisma.broadcastRun.update({
          where: { id: runId },
          data: { failedCount: { increment: 1 }, pendingCount }
        });

        continue;
      }

      // Send message
      const sendResult = await mtprotoSender.sendToGroup({
        encryptedSession: params.encryptedSession,
        groupIdentifier,
        sendMode: params.sendMode,
        text,
        mediaUrl: undefined,
        forwardSourceChatId: params.forwardSourceChatId,
        forwardMessageId: params.forwardMessageId
      });

      if (sendResult.ok) {
        cycleSent += 1;
        consecutiveFails = 0; // Reset consecutive fails on success

        await prisma.sendLog.create({
          data: {
            runId,
            groupId: group.id,
            accountId: params.accountId,
            cycleNumber,
            status: SendStatus.SUCCESS
          }
        });

        await prisma.broadcastRun.update({
          where: { id: runId },
          data: { sentCount: { increment: 1 }, pendingCount: { decrement: 1 } }
        });
      } else {
        cycleFailed += 1;
        consecutiveFails += 1;

        await prisma.sendLog.create({
          data: {
            runId,
            groupId: group.id,
            accountId: params.accountId,
            cycleNumber,
            status: SendStatus.FAILED,
            errorCode: sendResult.errorCode,
            errorMessage: sendResult.errorMessage
          }
        });

        await prisma.broadcastRun.update({
          where: { id: runId },
          data: {
            failedCount: { increment: 1 },
            pendingCount: { decrement: 1 },
            consecutiveFailCount: consecutiveFails
          }
        });

        // Handle FLOOD_WAIT → auto-pause with timer
        if (setting.autoPauseOnLimit && sendResult.errorCode === "FLOOD_WAIT" && sendResult.floodWaitSeconds) {
          const pausedUntil = new Date(Date.now() + sendResult.floodWaitSeconds * 1000);

          await prisma.broadcastRun.update({
            where: { id: runId },
            data: {
              status: RunStatus.PAUSED,
              reason: `Siklus ${cycleNumber}: FloodWait ${sendResult.floodWaitSeconds}s - auto-resume setelah cooldown`,
              pausedUntil,
              completedCycles: cycleNumber - 1
            }
          });

          await logActivity("worker", `Siklus ${cycleNumber}: FLOOD_WAIT ${sendResult.floodWaitSeconds}s - auto pause`, "WARN", {
            runId,
            cycleNumber,
            floodWaitSeconds: sendResult.floodWaitSeconds,
            cycleSent,
            cycleFailed,
            pausedUntil: pausedUntil.toISOString()
          });

          return {
            status: "paused",
            sent: cycleSent,
            failed: cycleFailed,
            skipped: cycleSkipped,
            durationMs: Date.now() - cycleStartTime,
            failReason: `FloodWait ${sendResult.floodWaitSeconds}s`
          };
        }

        // Handle PEER_FLOOD → pause (manual resume needed)
        if (setting.autoPauseOnLimit && sendResult.errorCode === "PEER_FLOOD") {
          await prisma.broadcastRun.update({
            where: { id: runId },
            data: {
              status: RunStatus.PAUSED,
              reason: `Siklus ${cycleNumber}: PeerFlood terdeteksi - perlu resume manual`,
              completedCycles: cycleNumber - 1
            }
          });

          await logActivity("worker", `Siklus ${cycleNumber}: PEER_FLOOD - pause manual`, "ERROR", {
            runId,
            cycleNumber,
            cycleSent,
            cycleFailed
          });

          return {
            status: "paused",
            sent: cycleSent,
            failed: cycleFailed,
            skipped: cycleSkipped,
            durationMs: Date.now() - cycleStartTime,
            failReason: "PeerFlood detected"
          };
        }
      }

      pendingCount -= 1;
    }

    start += batch.length;

    // Batch delay (between batches, not after last batch)
    if (start < groups.length) {
      const batchDelayMin = Math.max(0, setting.batchDelayMinMin);
      const batchDelayMax = Math.max(batchDelayMin, setting.batchDelayMaxMin);
      const delayMs = randomInt(batchDelayMin, batchDelayMax) * 60 * 1000;

      if (delayMs > 0) {
        await logActivity("worker", `Siklus ${cycleNumber}: Jeda antar batch ${Math.round(delayMs / 1000)}s`, "INFO", {
          runId,
          cycleNumber,
          batchDelayMs: delayMs,
          progress: `${start}/${groups.length}`
        });
        await sleep(delayMs);
      }
    }
  }

  const cycleDuration = Date.now() - cycleStartTime;

  await logActivity("worker", `Siklus ${cycleNumber} SELESAI`, "INFO", {
    runId,
    cycleNumber,
    sent: cycleSent,
    failed: cycleFailed,
    skipped: cycleSkipped,
    durationMs: cycleDuration,
    durationFormatted: formatDuration(cycleDuration),
    finishedAt: new Date().toISOString()
  });

  return {
    status: "ok",
    sent: cycleSent,
    failed: cycleFailed,
    skipped: cycleSkipped,
    durationMs: cycleDuration
  };
};

// ═══════════════════════════════════════════════════════════
// CORE: PROCESS BROADCAST RUN
// ═══════════════════════════════════════════════════════════

const processBroadcastRun = async (runId: string) => {
  // Peek at the current run to check if startedAt already exists (resume case)
  const existingRun = await prisma.broadcastRun.findUnique({
    where: { id: runId },
    select: { startedAt: true }
  });

  // Atomic claim: PENDING → RUNNING
  const claimed = await prisma.broadcastRun.updateMany({
    where: { id: runId, status: RunStatus.PENDING },
    data: {
      status: RunStatus.RUNNING,
      reason: null,
      consecutiveFailCount: 0,
      ...(existingRun?.startedAt ? {} : { startedAt: new Date() })
    }
  });

  if (claimed.count === 0) return;

  const run = await prisma.broadcastRun.findUnique({
    where: { id: runId },
    include: { setting: true }
  });

  if (!run || run.status === RunStatus.COMPLETED) return;

  // Select Telegram account
  const account = await selectAccount(run.requestedAccountId ?? undefined, run.id);
  if (!account?.encryptedSession) {
    await markRunFailed(run.id, "Tidak ada akun Telegram yang tersedia/terkoneksi");
    return;
  }

  // Parse payload
  const payload = parseRunPayload(run.requestedTemplateIds);
  const sendMode = payload?.mode ?? run.setting.sendMode;
  const directMessageText = payload?.messageText?.trim() ?? "";
  const forwardSourceChatId = payload?.forwardSourceChatId ?? run.setting.forwardSourceChatId;
  const forwardMessageId = payload?.forwardMessageId ?? run.setting.forwardMessageId ?? undefined;

  // Validate mode requirements
  if (sendMode === SendMode.NEW_MESSAGE && !directMessageText) {
    await markRunFailed(run.id, "Mode DIRECT_TEXT membutuhkan teks pesan yang tidak kosong");
    return;
  }
  if (sendMode === SendMode.FORWARD && !forwardSourceChatId) {
    await markRunFailed(run.id, "Mode FORWARD membutuhkan source chat yang valid");
    return;
  }

  // Fetch active groups
  const allGroups = await prisma.group.findMany({ where: { isActive: true } });
  if (allGroups.length === 0) {
    await markRunFailed(run.id, "Tidak ada grup aktif yang ditemukan");
    return;
  }

  const hasBatchInterval = run.totalDurationHours && run.intervalMinutes;
  const broadcastStartTime = run.startedAt ? run.startedAt.getTime() : Date.now();
  const totalDurationMs = hasBatchInterval ? run.totalDurationHours! * 60 * 60 * 1000 : 0;
  const intervalMs = hasBatchInterval ? run.intervalMinutes! * 60 * 1000 : 0;
  const maxCycles = hasBatchInterval
    ? Math.floor((run.totalDurationHours! * 60) / run.intervalMinutes!)
    : 1;

  // Resume: start from where we left off
  let completedCycles = run.completedCycles ?? 0;
  const cycleDetails: CycleDetail[] = (run.cycleDetails as CycleDetail[] | null) ?? [];

  // Total counters (cumulative across all cycles)
  let totalSent = run.sentCount ?? 0;
  let totalFailed = run.failedCount ?? 0;

  await logActivity("worker", "Broadcast run DIMULAI", "INFO", {
    runId: run.id,
    mode: hasBatchInterval ? "BATCH_INTERVAL" : "SINGLE",
    sendMode,
    totalGroups: allGroups.length,
    maxCycles,
    totalDurationHours: run.totalDurationHours,
    intervalMinutes: run.intervalMinutes,
    resumeFromCycle: completedCycles,
    accountPhone: account.phone
  });

  if (hasBatchInterval) {
    // ═══════════════════════════════════════════════════════
    // BATCH INTERVAL MODE: Multiple cycles
    // ═══════════════════════════════════════════════════════

    while (true) {
      // Check 1: Max cycles reached?
      if (completedCycles >= maxCycles) {
        await logActivity("worker", `Semua ${maxCycles} siklus tercapai`, "INFO", {
          runId: run.id,
          completedCycles,
          maxCycles,
          totalSent,
          totalFailed
        });
        break;
      }

      // Check 2: Duration expired?
      const elapsed = Date.now() - broadcastStartTime;
      if (elapsed >= totalDurationMs) {
        await logActivity("worker", "Durasi total broadcast habis", "INFO", {
          runId: run.id,
          completedCycles,
          elapsedMs: elapsed,
          totalDurationMs,
          totalSent,
          totalFailed
        });
        break;
      }

      // Check 3: Run still active?
      if (!(await isRunStillActive(run.id))) {
        await logActivity("worker", "Run dihentikan secara eksternal", "WARN", {
          runId: run.id,
          completedCycles,
          totalSent,
          totalFailed
        });
        return; // Don't mark as completed
      }

      const currentCycleNumber = completedCycles + 1;

      // Execute one cycle
      const cycleResult = await sendOneCycle({
        runId: run.id,
        cycleNumber: currentCycleNumber,
        accountId: account.id,
        encryptedSession: account.encryptedSession!,
        sendMode,
        messageText: directMessageText,
        forwardSourceChatId,
        forwardMessageId,
        setting: run.setting,
        allGroups
      });

      // Record cycle detail
      const cycleDetail: CycleDetail = {
        cycleNumber: currentCycleNumber,
        status: cycleResult.status === "ok" ? "completed" : cycleResult.status as any,
        startedAt: new Date(Date.now() - cycleResult.durationMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: cycleResult.durationMs,
        sent: cycleResult.sent,
        failed: cycleResult.failed,
        skipped: cycleResult.skipped,
        failReason: cycleResult.failReason
      };
      cycleDetails.push(cycleDetail);

      // Update cumulative totals
      totalSent += cycleResult.sent;
      totalFailed += cycleResult.failed;

      // Handle cycle result
      if (cycleResult.status === "paused") {
        // Run was paused (FloodWait, PeerFlood, or external)
        await prisma.broadcastRun.update({
          where: { id: run.id },
          data: {
            sentCount: totalSent,
            failedCount: totalFailed,
            completedCycles,
            cycleDetails: cycleDetails as any,
            lastCycleFinishedAt: new Date()
          }
        });
        return;
      }

      if (cycleResult.status === "failed") {
        // Anti-spam triggered
        await prisma.broadcastRun.update({
          where: { id: run.id },
          data: {
            sentCount: totalSent,
            failedCount: totalFailed,
            completedCycles,
            cycleDetails: cycleDetails as any,
            lastCycleFinishedAt: new Date()
          }
        });
        return;
      }

      if (cycleResult.status === "cancelled") {
        return;
      }

      // Cycle completed successfully
      completedCycles += 1;

      const isLastCycle = completedCycles >= maxCycles;

      // Update run state
      await prisma.broadcastRun.update({
        where: { id: run.id },
        data: {
          completedCycles,
          sentCount: totalSent,
          failedCount: totalFailed,
          lastCycleFinishedAt: new Date(),
          currentCycleNumber: currentCycleNumber,
          cycleDetails: cycleDetails as any,
          consecutiveFailCount: 0,
          reason: isLastCycle
            ? `Semua ${completedCycles}/${maxCycles} siklus selesai.`
            : `Siklus ${completedCycles}/${maxCycles} selesai. Menunggu ${run.intervalMinutes} menit...`
        }
      });

      if (isLastCycle) {
        await logActivity("worker", `Semua siklus selesai (${completedCycles}/${maxCycles})`, "INFO", {
          runId: run.id,
          completedCycles,
          maxCycles,
          totalSent,
          totalFailed
        });
        break;
      }

      // ═══ INTERVAL WAIT ═══
      // Ensure the full interval passes before starting next cycle
      const cycleFinishedAt = Date.now();
      const nextCycleAt = new Date(cycleFinishedAt + intervalMs);

      // Check if there's enough time for next cycle
      const elapsedAfterCycle = cycleFinishedAt - broadcastStartTime;
      if (elapsedAfterCycle + intervalMs > totalDurationMs) {
        await logActivity("worker", "Tidak cukup waktu untuk siklus berikutnya", "INFO", {
          runId: run.id,
          completedCycles,
          remainingMs: totalDurationMs - elapsedAfterCycle,
          intervalMs
        });
        break;
      }

      // Update nextCycleAt for monitoring
      await prisma.broadcastRun.update({
        where: { id: run.id },
        data: {
          nextCycleAt,
          reason: `Siklus ${completedCycles}/${maxCycles} selesai. Siklus berikutnya: ${nextCycleAt.toLocaleTimeString("id-ID")} (interval ${run.intervalMinutes} menit)`
        }
      });

      await logActivity("worker", `Menunggu interval ${run.intervalMinutes} menit sebelum siklus ${completedCycles + 1}`, "INFO", {
        runId: run.id,
        completedCycles,
        nextCycleAt: nextCycleAt.toISOString(),
        intervalMinutes: run.intervalMinutes
      });

      // ═══ GUARANTEED INTERVAL WAIT ═══
      // Wait until the absolute nextCycleAt time, not just relative interval
      // This ensures interval is fully respected even after pause/resume
      let aborted = false;
      while (Date.now() < nextCycleAt.getTime()) {
        const remainingWait = nextCycleAt.getTime() - Date.now();
        const sleepChunk = Math.min(INTERVAL_CHECK_MS, remainingWait);

        if (sleepChunk <= 0) break;
        await sleep(sleepChunk);

        // Check if run was paused/cancelled during wait
        if (!(await isRunStillActive(run.id))) {
          aborted = true;
          break;
        }
      }

      if (aborted) {
        await logActivity("worker", "Run dihentikan saat menunggu interval", "WARN", {
          runId: run.id,
          completedCycles
        });
        return;
      }

      // Clear nextCycleAt since we're starting
      await prisma.broadcastRun.update({
        where: { id: run.id },
        data: { nextCycleAt: null }
      });

      // Anti-spam: Minimum cooldown between cycles
      await sleep(COOLDOWN_AFTER_CYCLE_MS);
    }
  } else {
    // ═══════════════════════════════════════════════════════
    // SINGLE RUN MODE: One cycle only
    // ═══════════════════════════════════════════════════════

    const cycleResult = await sendOneCycle({
      runId: run.id,
      cycleNumber: 1,
      accountId: account.id,
      encryptedSession: account.encryptedSession!,
      sendMode,
      messageText: directMessageText,
      forwardSourceChatId,
      forwardMessageId,
      setting: run.setting,
      allGroups
    });

    if (cycleResult.status === "paused" || cycleResult.status === "failed") {
      // Already handled in sendOneCycle
      return;
    }

    totalSent = cycleResult.sent;
    totalFailed = cycleResult.failed;
    completedCycles = 1;

    cycleDetails.push({
      cycleNumber: 1,
      status: "completed",
      startedAt: new Date(Date.now() - cycleResult.durationMs).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: cycleResult.durationMs,
      sent: cycleResult.sent,
      failed: cycleResult.failed,
      skipped: cycleResult.skipped
    });
  }

  // ═══ MARK COMPLETED ═══
  await prisma.broadcastRun.update({
    where: { id: run.id },
    data: {
      status: RunStatus.COMPLETED,
      finishedAt: new Date(),
      sentCount: totalSent,
      failedCount: totalFailed,
      pendingCount: 0,
      completedCycles,
      currentCycleNumber: completedCycles,
      lastCycleFinishedAt: new Date(),
      nextCycleAt: null,
      consecutiveFailCount: 0,
      cycleDetails: cycleDetails as any,
      reason: `Selesai: ${completedCycles} siklus, ${totalSent} terkirim, ${totalFailed} gagal.`
    }
  });

  await logActivity("worker", "Broadcast run SELESAI", "INFO", {
    runId: run.id,
    totalSent,
    totalFailed,
    completedCycles,
    totalDuration: formatDuration(Date.now() - broadcastStartTime)
  });
};

// ═══════════════════════════════════════════════════════════
// RECOVERY & TICK
// ═══════════════════════════════════════════════════════════

const resumeDuePausedRuns = async () => {
  const resumed = await prisma.broadcastRun.updateMany({
    where: {
      status: RunStatus.PAUSED,
      pausedUntil: { lte: new Date() }
    },
    data: {
      status: RunStatus.PENDING,
      pausedUntil: null,
      reason: "Auto-resume setelah cooldown selesai"
    }
  });

  if (resumed.count > 0) {
    await logActivity("worker", `${resumed.count} run auto-resumed dari pause`, "INFO", {
      resumedCount: resumed.count
    });
  }
};

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
        reason: `Auto-recovered: server restart terdeteksi. Melanjutkan dari siklus ${stale.completedCycles}, ${stale.sentCount} terkirim, ${stale.failedCount} gagal.`
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
  if (tickLock) return;
  tickLock = true;

  try {
    await recoverStaleRunningRuns();
    await resumeDuePausedRuns();

    const pendingRuns = await prisma.broadcastRun.findMany({
      where: { status: RunStatus.PENDING },
      orderBy: { createdAt: "asc" }
    });

    for (const pending of pendingRuns) {
      if (activeRunIds.has(pending.id)) continue;

      activeRunIds.add(pending.id);

      // Fire-and-forget: run concurrently
      void (async () => {
        try {
          await processBroadcastRun(pending.id);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          await logActivity("worker", "Broadcast run gagal (unexpected error)", "ERROR", {
            runId: pending.id,
            error: errorMsg,
            stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined
          });

          // Mark as failed to prevent infinite retry
          try {
            await prisma.broadcastRun.update({
              where: { id: pending.id },
              data: {
                status: RunStatus.FAILED,
                reason: `Unexpected error: ${errorMsg}`,
                finishedAt: new Date()
              }
            });
          } catch {
            // Best effort
          }
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
    const updated = await prisma.broadcastRun.updateMany({
      where: { status: RunStatus.RUNNING },
      data: {
        status: RunStatus.PENDING,
        reason: "Server shutdown — broadcast akan otomatis dilanjutkan saat server nyala kembali."
      }
    });

    if (updated.count > 0) {
      await logActivity("worker", `Graceful shutdown: ${updated.count} run di-pause`, "WARN", {
        count: updated.count
      });
    }
  } catch {
    // DB might already be disconnected
  }
};

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}j ${minutes % 60}m ${seconds % 60}d`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}d`;
  }
  return `${seconds}d`;
}

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

export const startBroadcastWorker = () => {
  void processTick();
  return setInterval(() => {
    void processTick();
  }, env.RUN_POLL_INTERVAL_MS);
};

export { gracefulShutdown };
