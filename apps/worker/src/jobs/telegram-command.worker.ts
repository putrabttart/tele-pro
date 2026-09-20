import { RunStatus, TelegramConnectionStatus } from "@prisma/client";
import { prisma, dbRetry } from "../config/prisma";
import { getTelegramNotifyChatId, sendTelegramMessage } from "../utils/telegram-notifier";

const botToken = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
const allowedChatId = getTelegramNotifyChatId();
const POLL_INTERVAL_MS = Number(process.env.NOTIFY_TELEGRAM_POLL_INTERVAL_MS ?? 3000);

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
    };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
};

let offset = 0;
let tickLock = false;
let initialized = false;

const formatDateTime = (date: Date | null | undefined) => date
  ? date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })
  : "-";

const formatRunName = (run: { id: string; label: string | null }) => run.label || `Run ${run.id.slice(0, 8)}`;

const isAllowedChat = (chatId: number) => {
  if (!allowedChatId) return true;
  return String(chatId) === String(allowedChatId);
};

const fetchUpdates = async () => {
  if (!botToken) return [] as TelegramUpdate[];

  const params = new URLSearchParams({
    timeout: "0",
    limit: "20",
    allowed_updates: JSON.stringify(["message"])
  });
  if (offset > 0) params.set("offset", String(offset));

  const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?${params.toString()}`);
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[telegram-command] getUpdates failed: ${response.status} ${await response.text()}`);
    return [];
  }

  const payload = await response.json() as { ok: boolean; result?: TelegramUpdate[] };
  return payload.result ?? [];
};

const sendHelp = async (chatId: string) => {
  await sendTelegramMessage(chatId, [
    "BLAST-TELE Bot siap.",
    "",
    "Command:",
    "/status - ringkasan kondisi sistem",
    "/broadcasts - daftar broadcast aktif/running",
    "/accounts - daftar akun Telegram dan statusnya",
    "/help - bantuan command"
  ]);
};

const sendStatus = async (chatId: string) => {
  const [connectedAccounts, disconnectedAccounts, activeRuns, pendingRuns, pausedRuns, activeGroups, latestFailed] = await dbRetry(() =>
    prisma.$transaction([
      prisma.telegramAccount.count({ where: { status: TelegramConnectionStatus.CONNECTED } }),
      prisma.telegramAccount.count({ where: { status: TelegramConnectionStatus.DISCONNECTED } }),
      prisma.broadcastRun.count({ where: { status: RunStatus.RUNNING } }),
      prisma.broadcastRun.count({ where: { status: RunStatus.PENDING } }),
      prisma.broadcastRun.count({ where: { status: RunStatus.PAUSED } }),
      prisma.group.count({ where: { isActive: true } }),
      prisma.broadcastRun.findFirst({
        where: { status: RunStatus.FAILED },
        orderBy: { updatedAt: "desc" },
        select: { id: true, label: true, reason: true, updatedAt: true }
      })
    ])
  );

  await sendTelegramMessage(chatId, [
    "Status BLAST-TELE",
    `Akun connected: ${connectedAccounts}`,
    `Akun disconnected: ${disconnectedAccounts}`,
    `Broadcast running: ${activeRuns}`,
    `Broadcast pending: ${pendingRuns}`,
    `Broadcast paused: ${pausedRuns}`,
    `Group aktif: ${activeGroups}`,
    latestFailed ? "" : null,
    latestFailed ? `Failed terbaru: ${formatRunName(latestFailed)}` : null,
    latestFailed ? `Alasan: ${latestFailed.reason ?? "-"}` : null,
    latestFailed ? `Waktu: ${formatDateTime(latestFailed.updatedAt)}` : null
  ].filter((line): line is string => line !== null));
};

const sendBroadcasts = async (chatId: string) => {
  const runs = await dbRetry(() =>
    prisma.broadcastRun.findMany({
      where: { status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        label: true,
        status: true,
        reason: true,
        requestedAccountId: true,
        sentCount: true,
        failedCount: true,
        pendingCount: true,
        totalGroups: true,
        totalDurationHours: true,
        intervalMinutes: true,
        completedCycles: true,
        startedAt: true,
        nextCycleAt: true,
        updatedAt: true
      }
    })
  );

  if (!runs.length) {
    await sendTelegramMessage(chatId, ["Tidak ada broadcast aktif saat ini."]);
    return;
  }

  const accountIds = Array.from(new Set(runs.map((run) => run.requestedAccountId).filter((id): id is string => Boolean(id))));
  const accounts = accountIds.length
    ? await dbRetry(() => prisma.telegramAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, label: true, phone: true }
      }))
    : [];
  const accountMap = new Map(accounts.map((account) => [account.id, `${account.label} (${account.phone})`]));

  const lines = runs.flatMap((run, index) => {
    const maxCycles = run.totalDurationHours && run.intervalMinutes
      ? Math.max(1, Math.floor((run.totalDurationHours * 60) / run.intervalMinutes))
      : null;

    return [
      `${index + 1}. ${formatRunName(run)} [${run.status}]`,
      `Run ID: ${run.id}`,
      `Akun: ${run.requestedAccountId ? accountMap.get(run.requestedAccountId) ?? run.requestedAccountId.slice(0, 8) : "Auto-select"}`,
      `Progress: sent ${run.sentCount}, failed ${run.failedCount}, pending ${run.pendingCount}/${run.totalGroups}`,
      maxCycles ? `Siklus: ${run.completedCycles}/${maxCycles}` : `Siklus: ${run.completedCycles}`,
      run.startedAt ? `Mulai: ${formatDateTime(run.startedAt)}` : "Mulai: belum mulai",
      run.nextCycleAt ? `Next cycle: ${formatDateTime(run.nextCycleAt)}` : null,
      run.reason ? `Info: ${run.reason}` : null,
      ""
    ].filter((line): line is string => line !== null);
  });

  await sendTelegramMessage(chatId, ["Broadcast aktif:", "", ...lines]);
};

const sendAccounts = async (chatId: string) => {
  const accounts = await dbRetry(() =>
    prisma.telegramAccount.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      select: { label: true, phone: true, status: true, lastLoginAt: true, updatedAt: true }
    })
  );

  if (!accounts.length) {
    await sendTelegramMessage(chatId, ["Belum ada akun Telegram di database."]);
    return;
  }

  await sendTelegramMessage(chatId, [
    "Daftar akun Telegram:",
    "",
    ...accounts.map((account, index) => `${index + 1}. ${account.label} (${account.phone}) - ${account.status} - login ${formatDateTime(account.lastLoginAt)}`)
  ]);
};

const handleCommand = async (chatId: string, text: string) => {
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await sendHelp(chatId);
      break;
    case "/status":
      await sendStatus(chatId);
      break;
    case "/broadcasts":
    case "/running":
      await sendBroadcasts(chatId);
      break;
    case "/accounts":
      await sendAccounts(chatId);
      break;
    default:
      await sendTelegramMessage(chatId, ["Command tidak dikenal. Ketik /help untuk daftar command."]);
      break;
  }
};

const tick = async () => {
  if (!botToken || tickLock) return;
  tickLock = true;

  try {
    const updates = await fetchUpdates();
    if (!updates.length) return;

    offset = Math.max(...updates.map((update) => update.update_id)) + 1;

    if (!initialized) {
      initialized = true;
      return;
    }

    for (const update of updates) {
      const message = update.message;
      if (!message?.text || !message.text.startsWith("/")) continue;

      const chatId = String(message.chat.id);
      if (!isAllowedChat(message.chat.id)) {
        await sendTelegramMessage(chatId, ["Chat ini tidak diizinkan memakai bot monitoring BLAST-TELE."]);
        continue;
      }

      await handleCommand(chatId, message.text);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[telegram-command] tick error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    tickLock = false;
  }
};

export const startTelegramCommandWorker = () => {
  if (!botToken) return null;

  void tick();
  return setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
};
