import fs from "node:fs";
import path from "node:path";
import { TelegramConnectionStatus } from "@prisma/client";
import { Api } from "telegram";
import { prisma } from "../src/config/prisma";
import { mtprotoClient } from "../src/telegram/mtproto-client";
import { decryptText } from "../src/utils/crypto";

const STORE_FOLDER_TITLE = process.env.STORE_FOLDER_TITLE ?? "Group STORE";
const INCLUDE_BUSY = process.env.INCLUDE_BUSY === "1";
const TARGET_ACCOUNT_LABEL = process.env.TARGET_ACCOUNT_LABEL;
const TARGET_ACCOUNT_ID = process.env.TARGET_ACCOUNT_ID;
const JOIN_DELAY_MS = Number(process.env.JOIN_DELAY_MS ?? 1500);
const MAX_FLOOD_WAIT_SEC = Number(process.env.MAX_FLOOD_WAIT_SEC ?? 120);
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveGroupFilePath = () => {
  const candidates = [
    process.env.GROUP_FILE,
    path.resolve(process.cwd(), "group.txt"),
    path.resolve(process.cwd(), "../../group.txt"),
    path.resolve(__dirname, "../../../group.txt")
  ].filter(Boolean) as string[];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`group.txt tidak ditemukan. Cek lokasi file atau set GROUP_FILE.`);
  }

  return found;
};

const normalizeUsername = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withoutUrl = trimmed
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^t\.me\//i, "")
    .split(/[/?#]/)[0];

  return withoutUrl.replace(/^@/, "").trim();
};

const loadUsernames = () => {
  const filePath = resolveGroupFilePath();
  const usernames = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map(normalizeUsername)
    .filter((item) => /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(item));

  return {
    filePath,
    usernames: Array.from(new Set(usernames))
  };
};

const writeAccountProgressFiles = async (accountId: string, usernames: string[], prefix?: string) => {
  if (!prefix) return;

  const accountGroups = await prisma.accountGroup.findMany({
    where: { accountId },
    select: { group: { select: { username: true } } }
  });
  const linkedUsernames = new Set(
    accountGroups
      .map((row) => row.group.username)
      .filter((username): username is string => Boolean(username))
      .map((username) => username.toLowerCase())
  );

  const joined = usernames.filter((username) => linkedUsernames.has(username.toLowerCase()));
  const notJoined = usernames.filter((username) => !linkedUsernames.has(username.toLowerCase()));
  const root = path.resolve(process.cwd(), "../..");

  fs.writeFileSync(path.join(root, `${prefix}-joined.txt`), joined.map((username) => `@${username}`).join("\n") + (joined.length ? "\n" : ""));
  fs.writeFileSync(path.join(root, `${prefix}-not-joined.txt`), notJoined.map((username) => `@${username}`).join("\n") + (notJoined.length ? "\n" : ""));
};

const toIdString = (value: unknown) => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (value && typeof value === "object" && "toString" in value) {
    const idValue = (value as { toString: () => string }).toString();
    if (idValue && idValue !== "[object Object]") {
      return idValue;
    }
  }

  return "";
};

const getChatUsername = (chat: Record<string, unknown>, fallback: string) => {
  if (typeof chat.username === "string" && chat.username.trim()) {
    return normalizeUsername(chat.username);
  }

  const usernames = Array.isArray(chat.usernames) ? chat.usernames : [];
  for (const item of usernames) {
    if (!item || typeof item !== "object") continue;
    const username = (item as { username?: unknown }).username;
    if (typeof username === "string" && username.trim()) {
      return normalizeUsername(username);
    }
  }

  return fallback;
};

const buildTelegramId = (chat: Record<string, unknown>) => {
  const id = toIdString(chat.id);
  if (!id) return undefined;

  if (chat.className === "Channel") return `-100${id}`;
  if (chat.className === "Chat") return `-${id}`;
  return undefined;
};

const toInputPeer = (chat: Record<string, unknown>) => {
  if (chat.className === "Channel") {
    return new Api.InputPeerChannel({
      channelId: chat.id as never,
      accessHash: (chat.accessHash ?? BigInt(0)) as never
    });
  }

  if (chat.className === "Chat") {
    return new Api.InputPeerChat({ chatId: chat.id as never });
  }

  return null;
};

const peerKey = (peer: Api.TypeInputPeer) => {
  const item = peer as unknown as Record<string, unknown>;
  const className = String(item.className ?? peer.constructor.name);
  const id = toIdString(item.channelId ?? item.chatId ?? item.userId ?? "");
  return `${className}:${id}`;
};

const parseFloodWaitSeconds = (message: string) => {
  const match = message.match(/FLOOD_WAIT_(\d+)/i) ?? message.match(/wait of (\d+) seconds/i);
  return match ? Number(match[1]) : null;
};

const isFloodWaitError = (message: string) => {
  return Boolean(parseFloodWaitSeconds(message));
};

const isAlreadyParticipantError = (message: string) => {
  return /already|USER_ALREADY_PARTICIPANT|CHANNELS_ALREADY/i.test(message);
};

const upsertGroupForAccount = async (accountId: string, chat: Record<string, unknown>, fallbackUsername: string) => {
  const username = getChatUsername(chat, fallbackUsername);
  const telegramId = buildTelegramId(chat);
  const title = typeof chat.title === "string" ? chat.title : undefined;
  const clauses = [
    username ? { username } : undefined,
    telegramId ? { telegramId } : undefined
  ].filter(Boolean) as Array<{ username?: string; telegramId?: string }>;

  if (!clauses.length) return null;

  const existing = await prisma.group.findFirst({ where: { OR: clauses } });
  const group = existing
    ? await prisma.group.update({
        where: { id: existing.id },
        data: {
          title: title ?? existing.title,
          isActive: true
        }
      })
    : await prisma.group.create({
        data: {
          username,
          telegramId,
          title,
          tags: [],
          isActive: true
        }
      });

  await prisma.accountGroup.createMany({
    data: [{ accountId, groupId: group.id }],
    skipDuplicates: true
  });

  return group.id;
};

const getDialogFilterTitle = (filter: unknown) => {
  const title = (filter as { title?: { text?: unknown } })?.title;
  return typeof title?.text === "string" ? title.text : "";
};

const findStoreFilter = async (client: Awaited<ReturnType<typeof mtprotoClient.connectFromSession>>) => {
  const response = await client.invoke(new Api.messages.GetDialogFilters());
  const filters = ((response as { filters?: unknown[] }).filters ?? []) as Array<Record<string, unknown>>;
  return filters.find((filter) => getDialogFilterTitle(filter).trim().toLowerCase() === STORE_FOLDER_TITLE.toLowerCase());
};

const nextFilterId = async (client: Awaited<ReturnType<typeof mtprotoClient.connectFromSession>>) => {
  const response = await client.invoke(new Api.messages.GetDialogFilters());
  const filters = ((response as { filters?: Array<{ id?: number }> }).filters ?? []);
  const usedIds = filters.map((filter) => filter.id).filter((id): id is number => typeof id === "number");
  return Math.max(1, ...usedIds) + 1;
};

const updateStoreFolder = async (
  client: Awaited<ReturnType<typeof mtprotoClient.connectFromSession>>,
  peers: Api.TypeInputPeer[]
) => {
  if (!peers.length) return { updated: false, peers: 0 };

  const storeFilter = await findStoreFilter(client);
  const includeMap = new Map<string, Api.TypeInputPeer>();

  if (storeFilter) {
    const existingPeers = (storeFilter.includePeers as Api.TypeInputPeer[] | undefined) ?? [];
    for (const peer of existingPeers) includeMap.set(peerKey(peer), peer);
  }

  for (const peer of peers) includeMap.set(peerKey(peer), peer);

  const id = typeof storeFilter?.id === "number" ? storeFilter.id : await nextFilterId(client);
  const title = (storeFilter?.title as Api.TypeTextWithEntities | undefined)
    ?? new Api.TextWithEntities({ text: STORE_FOLDER_TITLE, entities: [] });

  const filter = new Api.DialogFilter({
    contacts: Boolean(storeFilter?.contacts),
    nonContacts: Boolean(storeFilter?.nonContacts),
    groups: Boolean(storeFilter?.groups),
    broadcasts: Boolean(storeFilter?.broadcasts),
    bots: Boolean(storeFilter?.bots),
    excludeMuted: Boolean(storeFilter?.excludeMuted),
    excludeRead: Boolean(storeFilter?.excludeRead),
    excludeArchived: false,
    titleNoanimate: Boolean(storeFilter?.titleNoanimate),
    id,
    title,
    emoticon: typeof storeFilter?.emoticon === "string" ? storeFilter.emoticon : undefined,
    color: typeof storeFilter?.color === "number" ? storeFilter.color : undefined,
    pinnedPeers: (storeFilter?.pinnedPeers as Api.TypeInputPeer[] | undefined) ?? [],
    includePeers: Array.from(includeMap.values()),
    excludePeers: (storeFilter?.excludePeers as Api.TypeInputPeer[] | undefined) ?? []
  });

  await client.invoke(new Api.messages.UpdateDialogFilter({ id, filter }));
  return { updated: true, peers: peers.length };
};

const archivePeers = async (
  client: Awaited<ReturnType<typeof mtprotoClient.connectFromSession>>,
  peers: Api.TypeInputPeer[]
) => {
  let archived = 0;
  for (let start = 0; start < peers.length; start += 100) {
    const chunk = peers.slice(start, start + 100);
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: chunk.map((peer) => new Api.InputFolderPeer({ peer, folderId: 1 }))
    }));
    archived += chunk.length;
  }
  return archived;
};

const syncStoreAndArchive = async (
  client: Awaited<ReturnType<typeof mtprotoClient.connectFromSession>>,
  peersForStore: Map<string, Api.TypeInputPeer>,
  accountSummary: { storePeers: number; archived: number }
) => {
  const peers = Array.from(peersForStore.values());
  const storeResult = await updateStoreFolder(client, peers);
  accountSummary.storePeers = storeResult.peers;
  accountSummary.archived = await archivePeers(client, peers);
};

const main = async () => {
  const { filePath, usernames } = loadUsernames();
  if (!usernames.length) {
    throw new Error("Tidak ada username valid di group.txt");
  }

  const busyRuns = await prisma.broadcastRun.findMany({
    where: { status: { in: ["PENDING", "RUNNING", "PAUSED"] }, requestedAccountId: { not: null } },
    select: { id: true, label: true, status: true, requestedAccountId: true }
  });
  const busyAccountIds = new Set(busyRuns.map((run) => run.requestedAccountId).filter(Boolean) as string[]);

  const accounts = await prisma.telegramAccount.findMany({
    where: {
      status: TelegramConnectionStatus.CONNECTED,
      encryptedSession: { not: null },
      ...(TARGET_ACCOUNT_ID ? { id: TARGET_ACCOUNT_ID } : {}),
      ...(TARGET_ACCOUNT_LABEL ? { label: TARGET_ACCOUNT_LABEL } : {})
    },
    orderBy: { createdAt: "desc" }
  });

  const eligibleAccounts = INCLUDE_BUSY ? accounts : accounts.filter((account) => !busyAccountIds.has(account.id));
  const skippedBusyAccounts = accounts.filter((account) => busyAccountIds.has(account.id));

  console.log(JSON.stringify({
    filePath,
    usernames: usernames.length,
    connectedAccounts: accounts.length,
    eligibleAccounts: eligibleAccounts.map((account) => ({ id: account.id, label: account.label })),
    skippedBusyAccounts: skippedBusyAccounts.map((account) => ({ id: account.id, label: account.label }))
  }, null, 2));

  const summary: Array<Record<string, unknown>> = [];

  for (const account of eligibleAccounts) {
    if (!account.encryptedSession) continue;

    const session = decryptText(account.encryptedSession);
    const client = await mtprotoClient.connectFromSession(session);
    const accountSummary = {
      accountId: account.id,
      label: account.label,
      joined: 0,
      alreadyJoined: 0,
      dbLinked: 0,
      storePeers: 0,
      archived: 0,
      notFound: 0,
      failed: 0,
      errors: [] as Array<{ username: string; error: string }>
    };

    const peersForStore = new Map<string, Api.TypeInputPeer>();
    const existingAccountGroups = await prisma.accountGroup.findMany({
      where: { accountId: account.id },
      select: { group: { select: { username: true } } }
    });
    const linkedUsernames = new Set(
      existingAccountGroups
        .map((row) => row.group.username)
        .filter((username): username is string => Boolean(username))
        .map((username) => username.toLowerCase())
    );

    try {
      for (const username of usernames) {
        try {
          const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
          const chat = ((resolved as { chats?: unknown[] }).chats ?? [])[0] as Record<string, unknown> | undefined;

          if (!chat || (chat.className !== "Channel" && chat.className !== "Chat")) {
            accountSummary.notFound += 1;
            continue;
          }

          let joinedThisRun = false;
          const chatUsername = getChatUsername(chat, username);

          if (linkedUsernames.has(chatUsername.toLowerCase())) {
            accountSummary.alreadyJoined += 1;
          } else {
            try {
              await client.invoke(new Api.channels.JoinChannel({ channel: chat as never }));
              joinedThisRun = true;
              linkedUsernames.add(chatUsername.toLowerCase());
              accountSummary.joined += 1;
            } catch (joinError) {
              const message = joinError instanceof Error ? joinError.message : String(joinError);
              if (isAlreadyParticipantError(message)) {
                linkedUsernames.add(chatUsername.toLowerCase());
                accountSummary.alreadyJoined += 1;
              } else {
                const floodWait = parseFloodWaitSeconds(message);
                if (floodWait && floodWait <= MAX_FLOOD_WAIT_SEC) {
                  await sleep((floodWait + 2) * 1000);
                  await client.invoke(new Api.channels.JoinChannel({ channel: chat as never }));
                  joinedThisRun = true;
                  linkedUsernames.add(chatUsername.toLowerCase());
                  accountSummary.joined += 1;
                } else {
                  accountSummary.failed += 1;
                  accountSummary.errors.push({ username, error: message });
                  if (OUTPUT_PREFIX && isFloodWaitError(message)) {
                    await syncStoreAndArchive(client, peersForStore, accountSummary);
                    await writeAccountProgressFiles(account.id, usernames, OUTPUT_PREFIX);
                    throw new Error(`FloodWait saat join @${username}: ${message}`);
                  }
                  continue;
                }
              }
            }
          }

          const inputPeer = toInputPeer(chat);
          if (inputPeer) peersForStore.set(peerKey(inputPeer), inputPeer);

          const groupId = await upsertGroupForAccount(account.id, chat, username);
          if (groupId) accountSummary.dbLinked += 1;

          if (JOIN_DELAY_MS > 0 && (joinedThisRun || accountSummary.alreadyJoined > 0)) {
            await sleep(JOIN_DELAY_MS);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          accountSummary.failed += 1;
          accountSummary.errors.push({ username, error: message });
          if (OUTPUT_PREFIX && isFloodWaitError(message)) {
            await syncStoreAndArchive(client, peersForStore, accountSummary);
            await writeAccountProgressFiles(account.id, usernames, OUTPUT_PREFIX);
            throw error;
          }
        }
      }

      await syncStoreAndArchive(client, peersForStore, accountSummary);

      await prisma.activityLog.create({
        data: {
          module: "groups",
          level: "INFO",
          message: "Joined groups from group.txt",
          meta: accountSummary
        }
      });
    } finally {
      await writeAccountProgressFiles(account.id, usernames, OUTPUT_PREFIX);
      try { await client.disconnect(); } catch { /* ignore */ }
    }

    summary.push(accountSummary);
    console.log(JSON.stringify(accountSummary, null, 2));
  }

  console.log(JSON.stringify({ summary, skippedBusyAccounts: skippedBusyAccounts.length }, null, 2));
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
