import { RunStatus, SendMode, SendStatus, TelegramConnectionStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma, dbRetry } from "../config/prisma";
import { classifyError, mtprotoSender } from "../telegram/mtproto-sender";
import type { ErrorSeverity } from "../telegram/mtproto-sender";
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

// Anti-spam protection constants (IMPROVED)
const MAX_CONSECUTIVE_ACCOUNT_FAILS = 5; // Only count ACCOUNT-level fails (not group-level skips)
const MAX_TOTAL_FAIL_RATIO = 0.85; // Pause if >85% of messages fail in a cycle
const MIN_MESSAGES_FOR_RATIO_CHECK = 10; // Only check ratio after N messages
const COOLDOWN_AFTER_CYCLE_MS = 5_000; // 5s cooldown between cycles (minimum)
const STALE_RUN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const INTERVAL_CHECK_MS = 10_000; // Check every 10s during interval wait

// Progressive delay: increase delay after consecutive issues
const PROGRESSIVE_DELAY_MULTIPLIER = 1.5; // Multiply delay by this after each fail
const MAX_PROGRESSIVE_DELAY_MS = 180_000; // Cap at 3 minutes
const PROGRESSIVE_DELAY_RESET_AFTER = 3; // Reset after N consecutive successes

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
  await dbRetry(() =>
    prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.FAILED,
        reason: message,
        finishedAt: new Date()
      }
    })
  );

  await logActivity("worker", `Run FAILED: ${message}`, "ERROR", { runId, reason: message });
};

const selectAccount = async (accountId?: string, currentRunId?: string) => {
  if (accountId) {
    return dbRetry(() => prisma.telegramAccount.findUnique({ where: { id: accountId } }));
  }

  const busyRuns = await dbRetry(() =>
    prisma.broadcastRun.findMany({
      where: {
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] },
        requestedAccountId: { not: null },
        ...(currentRunId ? { id: { not: currentRunId } } : {})
      },
      select: { requestedAccountId: true }
    })
  );
  const busyAccountIds = new Set(busyRuns.map((r) => r.requestedAccountId!));

  const candidates = await dbRetry(() =>
    prisma.telegramAccount.findMany({
      where: { status: TelegramConnectionStatus.CONNECTED },
      orderBy: { updatedAt: "desc" }
    })
  );

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
 * Uses dbRetry to handle transient connection issues gracefully.
 * On DB failure, assumes run is still active (optimistic) to avoid false stops.
 */
const isRunStillActive = async (runId: string): Promise<boolean> => {
  try {
    const run = await dbRetry(() =>
      prisma.broadcastRun.findUnique({
        where: { id: runId },
        select: { status: true }
      })
    );
    return run?.status === RunStatus.RUNNING;
  } catch {
    // If DB is unreachable after retries, assume still active
    // to avoid stopping a broadcast due to transient DB issues
    return true;
  }
};

/**
 * Safe database write — retries on transient errors, but never throws.
 * Used for non-critical writes (SendLog, counter updates) that should not
 * crash the broadcast if the DB is temporarily unreachable.
 */
const safeDbWrite = async <T>(operation: () => Promise<T>): Promise<T | null> => {
  try {
    return await dbRetry(operation, 2, 1500);
  } catch (error) {
    // Log but don't crash — the broadcast continues
    const msg = error instanceof Error ? error.message : "Unknown DB error";
    // eslint-disable-next-line no-console
    console.warn(`[safeDbWrite] DB write failed after retries: ${msg.slice(0, 200)}`);
    return null;
  }
};

/**
 * Calculate progressive delay based on recent failure pattern.
 * More consecutive account-level fails = longer delay between messages.
 */
const calculateProgressiveDelay = (
  baseDelayMs: number,
  consecutiveAccountFails: number
): number => {
  if (consecutiveAccountFails === 0) return baseDelayMs;

  const multiplied = baseDelayMs * Math.pow(PROGRESSIVE_DELAY_MULTIPLIER, consecutiveAccountFails);
  return Math.min(multiplied, MAX_PROGRESSIVE_DELAY_MS);
};


// ═══════════════════════════════════════════════════════════
// CORE: SEND ONE CYCLE (IMPROVED ANTI-SPAM)
// ═══════════════════════════════════════════════════════════

/**
 * Execute one complete cycle of sending to all groups.
 * 
 * KEY IMPROVEMENTS:
 * 1. Error severity classification — only ACCOUNT-level errors count toward consecutive fails
 * 2. Group-level errors (CHAT_WRITE_FORBIDDEN, etc.) are SKIPPED without penalty
 * 3. Progressive delay — delay increases after account-level issues
 * 4. Fail ratio check — auto-pause if too many messages fail (indicates account problem)
 * 5. FLOOD_WAIT auto-handled by mtproto-sender (≤120s waits automatically)
 * 6. SLOWMODE_WAIT auto-handled by mtproto-sender (waits then retries)
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
  let consecutiveAccountFails = 0; // Only count account-level errors
  let consecutiveSuccesses = 0;
  let currentDelayMultiplier = 1;

  const { runId, cycleNumber, setting, allGroups } = params;

  // Update run: mark current cycle start
  await dbRetry(() =>
    prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        currentCycleStartedAt: new Date(),
        currentCycleNumber: cycleNumber,
        reason: `Siklus ${cycleNumber} sedang berjalan...`
      }
    })
  );

  await logActivity("worker", `Siklus ${cycleNumber} DIMULAI`, "INFO", {
    runId,
    cycleNumber,
    totalGroups: allGroups.length,
    startTime: new Date().toISOString()
  });

  // Only skip groups already sent IN THIS SPECIFIC CYCLE
  const alreadySentInThisCycle = await dbRetry(() =>
    prisma.sendLog.findMany({
      where: {
        runId,
        cycleNumber,
        status: SendStatus.SUCCESS
      },
      select: { groupId: true }
    })
  );
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

  await safeDbWrite(() =>
    prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        totalGroups: allGroups.length,
        pendingCount: groups.length,
        reason: `Siklus ${cycleNumber}: Mengirim ke ${groups.length} grup...`
      }
    })
  );

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

    // ═══ IMPROVED: Only count ACCOUNT-level consecutive fails ═══
    if (consecutiveAccountFails >= MAX_CONSECUTIVE_ACCOUNT_FAILS) {
      const reason = `Anti-spam: ${MAX_CONSECUTIVE_ACCOUNT_FAILS} kegagalan akun berturut-turut di siklus ${cycleNumber} (kemungkinan akun terkena limit)`;
      await safeDbWrite(() =>
        prisma.broadcastRun.update({
          where: { id: runId },
          data: {
            status: RunStatus.PAUSED,
            reason,
            consecutiveFailCount: consecutiveAccountFails,
            pausedUntil: new Date(Date.now() + 10 * 60 * 1000) // Auto-resume after 10 min
          }
        })
      );

      await logActivity("worker", `Siklus ${cycleNumber}: AUTO-PAUSE karena ${MAX_CONSECUTIVE_ACCOUNT_FAILS} gagal akun berturut`, "ERROR", {
        runId,
        cycleNumber,
        consecutiveAccountFails,
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

    // ═══ IMPROVED: Fail ratio check ═══
    const totalAttempted = cycleSent + cycleFailed - sentGroupIds.size;
    if (totalAttempted >= MIN_MESSAGES_FOR_RATIO_CHECK && cycleFailed > 0) {
      // Only count non-skip failures for ratio
      const accountFailRatio = consecutiveAccountFails > 0
        ? (cycleFailed - cycleSkipped) / Math.max(1, totalAttempted - cycleSkipped)
        : 0;

      if (accountFailRatio >= MAX_TOTAL_FAIL_RATIO) {
        const reason = `Anti-spam: Rasio kegagalan terlalu tinggi (${Math.round(accountFailRatio * 100)}%) di siklus ${cycleNumber}`;
        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: runId },
            data: {
              status: RunStatus.PAUSED,
              reason,
              pausedUntil: new Date(Date.now() + 15 * 60 * 1000) // Auto-resume after 15 min
            }
          })
        );

        await logActivity("worker", `Siklus ${cycleNumber}: AUTO-PAUSE karena fail ratio tinggi`, "ERROR", {
          runId,
          cycleNumber,
          accountFailRatio,
          cycleSent,
          cycleFailed,
          cycleSkipped
        });

        return {
          status: "failed",
          sent: cycleSent,
          failed: cycleFailed,
          skipped: cycleSkipped,
          durationMs: Date.now() - cycleStartTime,
          failReason: reason
        };
      }
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

      // ═══ IMPROVED: Progressive delay based on recent failures ═══
      const messageDelayMin = Math.max(1, setting.messageDelayMinSec);
      const messageDelayMax = Math.max(messageDelayMin, setting.messageDelayMaxSec);
      const baseDelayMs = randomInt(messageDelayMin, messageDelayMax) * 1000;
      const progressiveDelayMs = calculateProgressiveDelay(baseDelayMs, consecutiveAccountFails);
      const messageDelayMs = Math.max(progressiveDelayMs, env.MIN_SPACING_MS);
      await sleep(messageDelayMs);

      const groupIdentifier = resolveGroupIdentifier(group);
      if (!groupIdentifier) {
        // ═══ IMPROVED: Group identifier missing is a SKIP, not a consecutive fail ═══
        cycleSkipped += 1;
        pendingCount -= 1;

        await safeDbWrite(() =>
          prisma.sendLog.create({
            data: {
              runId,
              groupId: group.id,
              accountId: params.accountId,
              cycleNumber,
              status: SendStatus.SKIPPED,
              errorCode: "GROUP_IDENTIFIER_MISSING",
              errorMessage: "Group has no username or telegramId"
            }
          })
        );

        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: runId },
            data: { failedCount: { increment: 1 }, pendingCount }
          })
        );

        continue;
      }

      // Send message (with built-in retry for transient errors)
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
        consecutiveAccountFails = 0; // Reset account fails on success
        consecutiveSuccesses += 1;

        // Reset progressive delay after sustained success
        if (consecutiveSuccesses >= PROGRESSIVE_DELAY_RESET_AFTER) {
          currentDelayMultiplier = 1;
        }

        await safeDbWrite(() =>
          prisma.sendLog.create({
            data: {
              runId,
              groupId: group.id,
              accountId: params.accountId,
              cycleNumber,
              status: SendStatus.SUCCESS
            }
          })
        );

        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: runId },
            data: { sentCount: { increment: 1 }, pendingCount: { decrement: 1 } }
          })
        );
      } else {
        const severity = sendResult.severity ?? classifyError(sendResult.errorCode);

        // ═══ KEY IMPROVEMENT: Handle based on error severity ═══

        if (severity === "skip") {
          // Group-level issue — skip this group, NO penalty to consecutive fails
          cycleSkipped += 1;
          cycleFailed += 1;
          consecutiveSuccesses = 0;

          await safeDbWrite(() =>
            prisma.sendLog.create({
              data: {
                runId,
                groupId: group.id,
                accountId: params.accountId,
                cycleNumber,
                status: SendStatus.SKIPPED,
                errorCode: sendResult.errorCode,
                errorMessage: sendResult.errorMessage
              }
            })
          );

          await safeDbWrite(() =>
            prisma.broadcastRun.update({
              where: { id: runId },
              data: {
                failedCount: { increment: 1 },
                pendingCount: { decrement: 1 }
              }
            })
          );

          // Auto-deactivate group if it has a permanent issue
          if (
            sendResult.errorCode === "CHAT_WRITE_FORBIDDEN" ||
            sendResult.errorCode === "CHANNEL_PRIVATE" ||
            sendResult.errorCode === "USER_BANNED" ||
            sendResult.errorCode === "USER_DEACTIVATED" ||
            sendResult.errorCode === "CHAT_RESTRICTED"
          ) {
            await safeDbWrite(() =>
              prisma.group.update({
                where: { id: group.id },
                data: { isActive: false }
              })
            );

            await logActivity("worker", `Grup auto-deactivated: ${sendResult.errorCode}`, "WARN", {
              runId,
              groupId: group.id,
              groupIdentifier,
              errorCode: sendResult.errorCode
            });
          }

          continue; // Move to next group immediately
        }

        if (severity === "fatal") {
          // Session is dead — fail the entire run
          await markRunFailed(runId, `Session invalid: ${sendResult.errorMessage}`);
          return {
            status: "failed",
            sent: cycleSent,
            failed: cycleFailed,
            skipped: cycleSkipped,
            durationMs: Date.now() - cycleStartTime,
            failReason: "Session expired/invalid"
          };
        }

        if (severity === "pause") {
          // PEER_FLOOD — account-level spam detection, must pause
          cycleFailed += 1;
          consecutiveAccountFails += 1;
          consecutiveSuccesses = 0;

          await safeDbWrite(() =>
            prisma.sendLog.create({
              data: {
                runId,
                groupId: group.id,
                accountId: params.accountId,
                cycleNumber,
                status: SendStatus.FAILED,
                errorCode: sendResult.errorCode,
                errorMessage: sendResult.errorMessage
              }
            })
          );

          if (setting.autoPauseOnLimit) {
            // Pause with auto-resume after 30 minutes (PEER_FLOOD needs longer cooldown)
            const pausedUntil = new Date(Date.now() + 30 * 60 * 1000);
            await safeDbWrite(() =>
              prisma.broadcastRun.update({
                where: { id: runId },
                data: {
                  status: RunStatus.PAUSED,
                  reason: `Siklus ${cycleNumber}: PEER_FLOOD terdeteksi - auto-resume setelah 30 menit cooldown`,
                  pausedUntil,
                  failedCount: { increment: 1 },
                  pendingCount: { decrement: 1 },
                  consecutiveFailCount: consecutiveAccountFails
                }
              })
            );

            await logActivity("worker", `Siklus ${cycleNumber}: PEER_FLOOD - auto-pause 30 menit`, "ERROR", {
              runId,
              cycleNumber,
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
              failReason: "PeerFlood detected - auto-resume in 30min"
            };
          }

          continue;
        }

        // severity === "wait_retry" — already retried by mtproto-sender, still failed
        // This means the retry mechanism exhausted all attempts
        cycleFailed += 1;
        consecutiveAccountFails += 1;
        consecutiveSuccesses = 0;

        await safeDbWrite(() =>
          prisma.sendLog.create({
            data: {
              runId,
              groupId: group.id,
              accountId: params.accountId,
              cycleNumber,
              status: SendStatus.FAILED,
              errorCode: sendResult.errorCode,
              errorMessage: sendResult.errorMessage
            }
          })
        );

        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: runId },
            data: {
              failedCount: { increment: 1 },
              pendingCount: { decrement: 1 },
              consecutiveFailCount: consecutiveAccountFails
            }
          })
        );

        // Handle FLOOD_WAIT that was too long for auto-wait (>120s)
        if (setting.autoPauseOnLimit && sendResult.errorCode === "FLOOD_WAIT" && sendResult.floodWaitSeconds) {
          const pausedUntil = new Date(Date.now() + (sendResult.floodWaitSeconds + 10) * 1000);

          await safeDbWrite(() =>
            prisma.broadcastRun.update({
              where: { id: runId },
              data: {
                status: RunStatus.PAUSED,
                reason: `Siklus ${cycleNumber}: FloodWait ${sendResult.floodWaitSeconds}s (terlalu lama) - auto-resume setelah cooldown`,
                pausedUntil,
                completedCycles: cycleNumber - 1
              }
            })
          );

          await logActivity("worker", `Siklus ${cycleNumber}: FLOOD_WAIT ${sendResult.floodWaitSeconds}s (>120s) - auto pause`, "WARN", {
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
            failReason: `FloodWait ${sendResult.floodWaitSeconds}s (auto-resume scheduled)`
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
  const existingRun = await dbRetry(() =>
    prisma.broadcastRun.findUnique({
      where: { id: runId },
      select: { startedAt: true, status: true }
    })
  );

  if (!existingRun || (existingRun.status !== RunStatus.RUNNING && existingRun.status !== RunStatus.PENDING)) {
    return;
  }

  // Ensure it's marked as RUNNING with proper fields
  await dbRetry(() =>
    prisma.broadcastRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.RUNNING,
        reason: null,
        consecutiveFailCount: 0,
        ...(existingRun.startedAt ? {} : { startedAt: new Date() })
      }
    })
  );

  const run = await dbRetry(() =>
    prisma.broadcastRun.findUnique({
      where: { id: runId },
      include: { setting: true }
    })
  );

  if (!run || run.status === RunStatus.COMPLETED) return;

  // Select Telegram account
  const account = await selectAccount(run.requestedAccountId ?? undefined, run.id);
  if (!account?.encryptedSession) {
    await markRunFailed(run.id, "Tidak ada akun Telegram yang tersedia/terkoneksi");
    return;
  }

  // Lock: Save the selected account to the run so other runs won't pick the same account
  if (!run.requestedAccountId) {
    await safeDbWrite(() =>
      prisma.broadcastRun.update({
        where: { id: run.id },
        data: { requestedAccountId: account.id }
      })
    );
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

  // Fetch active groups for this account only
  const allGroups = await dbRetry(() =>
    prisma.group.findMany({
      where: {
        isActive: true,
        accounts: { some: { accountId: account.id } }
      }
    })
  );
  if (allGroups.length === 0) {
    await markRunFailed(run.id, "Tidak ada grup aktif untuk akun ini");
    return;
  }

  const hasBatchInterval = run.totalDurationHours && run.intervalMinutes;
  const broadcastStartTime = run.startedAt ? run.startedAt.getTime() : Date.now();
  const totalDurationMs = hasBatchInterval ? run.totalDurationHours! * 60 * 60 * 1000 : 0;
  const intervalMs = hasBatchInterval ? run.intervalMinutes! * 60 * 1000 : 0;

  const maxCycles = hasBatchInterval
    ? Math.max(1, Math.floor((run.totalDurationHours! * 60) / run.intervalMinutes!))
    : 1;

  // Resume: start from where we left off
  let completedCycles = run.completedCycles ?? 0;
  const cycleDetails: CycleDetail[] = (run.cycleDetails as CycleDetail[] | null) ?? [];

  // Total counters (cumulative across all cycles)
  let totalSent = run.sentCount ?? 0;
  let totalFailed = run.failedCount ?? 0;

  const safeMaxCycles = maxCycles;

  await logActivity("worker", "Broadcast run DIMULAI", "INFO", {
    runId: run.id,
    mode: hasBatchInterval ? "BATCH_INTERVAL" : "SINGLE",
    sendMode,
    totalGroups: allGroups.length,
    maxCycles: safeMaxCycles,
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
      if (completedCycles >= safeMaxCycles) {
        await logActivity("worker", `Semua ${safeMaxCycles} siklus tercapai`, "INFO", {
          runId: run.id,
          completedCycles,
          maxCycles: safeMaxCycles,
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

      // Re-read actual counts from DB to avoid double-counting
      const freshRun = await dbRetry(() =>
        prisma.broadcastRun.findUnique({
          where: { id: run.id },
          select: { sentCount: true, failedCount: true }
        })
      ).catch(() => null);
      totalSent = freshRun?.sentCount ?? totalSent;
      totalFailed = freshRun?.failedCount ?? totalFailed;

      // Handle cycle result
      if (cycleResult.status === "paused") {
        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: run.id },
            data: {
              sentCount: totalSent,
              failedCount: totalFailed,
              completedCycles,
              cycleDetails: cycleDetails as any,
              lastCycleFinishedAt: new Date()
            }
          })
        );
        return;
      }

      if (cycleResult.status === "failed") {
        await safeDbWrite(() =>
          prisma.broadcastRun.update({
            where: { id: run.id },
            data: {
              sentCount: totalSent,
              failedCount: totalFailed,
              completedCycles,
              cycleDetails: cycleDetails as any,
              lastCycleFinishedAt: new Date()
            }
          })
        );
        return;
      }

      if (cycleResult.status === "cancelled") {
        return;
      }

      // Cycle completed successfully
      completedCycles += 1;

      const isLastCycle = completedCycles >= safeMaxCycles;

      // Update run state
      await safeDbWrite(() =>
        prisma.broadcastRun.update({
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
              ? `Semua ${completedCycles}/${safeMaxCycles} siklus selesai.`
              : `Siklus ${completedCycles}/${safeMaxCycles} selesai. Menunggu ${run.intervalMinutes} menit...`
          }
        })
      );

      if (isLastCycle) {
        await logActivity("worker", `Semua siklus selesai (${completedCycles}/${safeMaxCycles})`, "INFO", {
          runId: run.id,
          completedCycles,
          maxCycles: safeMaxCycles,
          totalSent,
          totalFailed
        });
        break;
      }

      // ═══ INTERVAL WAIT ═══
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
      await safeDbWrite(() =>
        prisma.broadcastRun.update({
          where: { id: run.id },
          data: {
            nextCycleAt,
            reason: `Siklus ${completedCycles}/${safeMaxCycles} selesai. Siklus berikutnya: ${nextCycleAt.toLocaleTimeString("id-ID")} (interval ${run.intervalMinutes} menit)`
          }
        })
      );

      await logActivity("worker", `Menunggu interval ${run.intervalMinutes} menit sebelum siklus ${completedCycles + 1}`, "INFO", {
        runId: run.id,
        completedCycles,
        nextCycleAt: nextCycleAt.toISOString(),
        intervalMinutes: run.intervalMinutes
      });

      // ═══ GUARANTEED INTERVAL WAIT ═══
      let aborted = false;
      let heartbeatTicks = 0;
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

        // Heartbeat: touch updatedAt every ~60s
        heartbeatTicks++;
        if (heartbeatTicks % 6 === 0) {
          await safeDbWrite(() =>
            prisma.broadcastRun.update({
              where: { id: run.id },
              data: {
                updatedAt: new Date(),
                reason: `Siklus ${completedCycles}/${safeMaxCycles} selesai. Menunggu siklus berikutnya: ${nextCycleAt.toLocaleTimeString("id-ID")} (sisa ${Math.ceil(remainingWait / 60000)} menit)`
              }
            })
          );
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
      await safeDbWrite(() =>
        prisma.broadcastRun.update({
          where: { id: run.id },
          data: { nextCycleAt: null }
        })
      );

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
      return;
    }

    // Read actual counts from DB
    const freshSingleRun = await dbRetry(() =>
      prisma.broadcastRun.findUnique({
        where: { id: run.id },
        select: { sentCount: true, failedCount: true }
      })
    ).catch(() => null);
    totalSent = freshSingleRun?.sentCount ?? cycleResult.sent;
    totalFailed = freshSingleRun?.failedCount ?? cycleResult.failed;
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
  await dbRetry(() =>
    prisma.broadcastRun.update({
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
    })
  );

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
  const resumed = await dbRetry(() =>
    prisma.broadcastRun.updateMany({
      where: {
        status: RunStatus.PAUSED,
        pausedUntil: { lte: new Date() }
      },
      data: {
        status: RunStatus.PENDING,
        pausedUntil: null,
        reason: "Auto-resume setelah cooldown selesai"
      }
    })
  );

  if (resumed.count > 0) {
    await logActivity("worker", `${resumed.count} run auto-resumed dari pause`, "INFO", {
      resumedCount: resumed.count
    });
  }
};

const recoverStaleRunningRuns = async () => {
  const staleThreshold = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);

  const staleRuns = await dbRetry(() =>
    prisma.broadcastRun.findMany({
      where: {
        status: RunStatus.RUNNING,
        updatedAt: { lte: staleThreshold }
      },
      select: { id: true, sentCount: true, failedCount: true, completedCycles: true, nextCycleAt: true }
    })
  );

  if (staleRuns.length === 0) return;

  for (const stale of staleRuns) {
    // Skip if the run is waiting for its next cycle interval
    if (stale.nextCycleAt && stale.nextCycleAt.getTime() > Date.now()) {
      continue;
    }

    // Skip if this worker instance is actively processing this run
    if (activeRunIds.has(stale.id)) {
      continue;
    }

    await dbRetry(() =>
      prisma.broadcastRun.update({
        where: { id: stale.id },
        data: {
          status: RunStatus.PENDING,
          reason: `Auto-recovered: server restart terdeteksi. Melanjutkan dari siklus ${stale.completedCycles}, ${stale.sentCount} terkirim, ${stale.failedCount} gagal.`
        }
      })
    );

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

    const pendingRuns = await dbRetry(() =>
      prisma.broadcastRun.findMany({
        where: { status: RunStatus.PENDING },
        orderBy: { createdAt: "asc" }
      })
    );

    for (const pending of pendingRuns) {
      // Skip runs already being processed
      if (activeRunIds.has(pending.id)) {
        await logActivity("worker", "Skipping run already in-progress locally", "WARN", {
          runId: pending.id,
          activeRunCount: activeRunIds.size
        });
        continue;
      }

      // Atomically claim the run
      const claimed = await dbRetry(() =>
        prisma.broadcastRun.updateMany({
          where: { id: pending.id, status: RunStatus.PENDING },
          data: { status: RunStatus.RUNNING }
        })
      );

      if (claimed.count === 0) {
        continue;
      }

      activeRunIds.add(pending.id);

      // Fire-and-forget: run concurrently
      void (async () => {
        try {
          await processBroadcastRun(pending.id);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          const isDbConnectionError = /can't reach database|timed out fetching.*connection pool|connection reset|ECONNRESET|ETIMEDOUT|socket hang up|connection refused|connection closed/i.test(errorMsg);

          await logActivity("worker", "Broadcast run gagal (unexpected error)", "ERROR", {
            runId: pending.id,
            error: errorMsg,
            isDbError: isDbConnectionError,
            stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined
          }).catch(() => {});

          if (isDbConnectionError) {
            // Database connection error — DON'T mark as FAILED
            // Set back to PENDING so it will be retried on next tick
            try {
              await dbRetry(() =>
                prisma.broadcastRun.update({
                  where: { id: pending.id },
                  data: {
                    status: RunStatus.PENDING,
                    reason: `DB connection lost — auto-retry pada tick berikutnya. Error: ${errorMsg.slice(0, 100)}`
                  }
                })
              );
            } catch {
              // If even this fails, the recoverStaleRunningRuns will pick it up
            }
          } else {
            // Non-DB error — mark as failed to prevent infinite retry
            try {
              await dbRetry(() =>
                prisma.broadcastRun.update({
                  where: { id: pending.id },
                  data: {
                    status: RunStatus.FAILED,
                    reason: `Unexpected error: ${errorMsg}`,
                    finishedAt: new Date()
                  }
                })
              );
            } catch {
              // Best effort
            }
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
 * Also disconnect all pooled Telegram clients.
 */
const gracefulShutdown = async () => {
  try {
    // Disconnect all pooled Telegram clients
    await mtprotoSender.disconnectAll();

    const updated = await prisma.broadcastRun.updateMany({
      where: { status: RunStatus.RUNNING },
      data: {
        status: RunStatus.PENDING,
        reason: "Server shutdown — broadcast akan otomatis dilanjutkan saat server nyala kembali."
      }
    }).catch(() => ({ count: 0 }));

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
