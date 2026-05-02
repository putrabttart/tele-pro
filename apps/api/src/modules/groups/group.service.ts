import { TelegramConnectionStatus } from "@prisma/client";
import { Api } from "telegram";
import { prisma } from "../../config/prisma";
import { mtprotoClient } from "../../telegram/mtproto-client";
import { ApiError } from "../../utils/api-error";
import { decryptText } from "../../utils/crypto";
import { logActivity } from "../../utils/logger";
import { extractAddlistSlug, parseGroupLink } from "../../utils/telegram-links";

type UpsertGroupInput = {
  telegramId?: string;
  username?: string;
  title?: string;
  tags?: string[];
  isActive?: boolean;
};

type UpsertGroupResult = {
  status: "created" | "updated" | "skipped";
  groupId?: string;
};

type BatchAccountResult = {
  accountId: string;
  label: string;
  phone: string;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  joined: number;
  notFound: number;
  joinFailed: number;
};

type BatchAddResult = {
  target: "single" | "all";
  totalUsernames: number;
  accounts: BatchAccountResult[];
  totals: {
    accounts: number;
    created: number;
    updated: number;
    skipped: number;
    joined: number;
    notFound: number;
    joinFailed: number;
  };
};

const normalizeUsername = (username?: string) => {
  if (!username) {
    return undefined;
  }
  return username.replace(/^@/, "").trim();
};

const isValidUsername = (value: string) => {
  return /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(value);
};

const parseIdentifier = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return {} as { telegramId?: string; username?: string };
  }

  if (/^-?\d+$/.test(trimmed)) {
    return { telegramId: trimmed };
  }

  return { username: normalizeUsername(trimmed) };
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

const resolveUsernameFromChat = (chat: Record<string, unknown>) => {
  const directUsername = typeof chat.username === "string" ? chat.username : undefined;
  if (directUsername) {
    return normalizeUsername(directUsername);
  }

  const usernames = Array.isArray(chat.usernames) ? chat.usernames : [];
  for (const item of usernames) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const user = (item as { username?: unknown }).username;
    if (typeof user === "string" && user.trim()) {
      return normalizeUsername(user);
    }
  }

  return undefined;
};

const buildGroupFromChat = (
  chatValue: unknown,
  defaultTags: string[],
  options?: { isActive?: boolean }
) => {
  if (!chatValue || typeof chatValue !== "object") {
    return null;
  }

  const chat = chatValue as Record<string, unknown>;
  const className = typeof chat.className === "string" ? chat.className : "";
  const id = toIdString(chat.id);
  const title = typeof chat.title === "string" ? chat.title : undefined;
  const username = resolveUsernameFromChat(chat);
  const isActive = options?.isActive;

  if (username) {
    return {
      username,
      title,
      tags: defaultTags,
      isActive
    } as UpsertGroupInput;
  }

  if (!id) {
    return null;
  }

  if (className === "Channel") {
    return {
      telegramId: `-100${id}`,
      title,
      tags: defaultTags,
      isActive
    } as UpsertGroupInput;
  }

  if (className === "Chat") {
    return {
      telegramId: `-${id}`,
      title,
      tags: defaultTags,
      isActive
    } as UpsertGroupInput;
  }

  return null;
};

class GroupService {
  private async upsertGroup(data: UpsertGroupInput): Promise<UpsertGroupResult> {
    const username = normalizeUsername(data.username);
    const telegramId = data.telegramId?.trim();

    if (!username && !telegramId) {
      return { status: "skipped" };
    }

    const whereClause = [
      telegramId ? { telegramId } : undefined,
      username ? { username } : undefined
    ].filter(Boolean) as Array<{ telegramId?: string; username?: string }>;

    const existing = await prisma.group.findFirst({
      where: {
        OR: whereClause
      }
    });

    const tags = Array.from(new Set(data.tags ?? []));

    if (existing) {
      await prisma.group.update({
        where: { id: existing.id },
        data: {
          title: data.title ?? existing.title,
          tags: Array.from(new Set([...(existing.tags ?? []), ...tags])),
          isActive: data.isActive ?? existing.isActive
        }
      });

      return { status: "updated", groupId: existing.id };
    }

    const created = await prisma.group.create({
      data: {
        telegramId,
        username,
        title: data.title,
        tags,
        isActive: data.isActive ?? true
      }
    });

    return { status: "created", groupId: created.id };
  }

  private async linkAccountGroups(accountId: string, groupIds: string[]) {
    if (!groupIds.length) {
      return;
    }

    await prisma.accountGroup.createMany({
      data: groupIds.map((groupId) => ({ accountId, groupId })),
      skipDuplicates: true
    });
  }

  async list(search?: string, tag?: string, accountId?: string) {
    return prisma.group.findMany({
      where: {
        AND: [
          accountId ? { accounts: { some: { accountId } } } : {},
          search
            ? {
                OR: [
                  { username: { contains: search, mode: "insensitive" } },
                  { telegramId: { contains: search, mode: "insensitive" } },
                  { title: { contains: search, mode: "insensitive" } }
                ]
              }
            : {},
          tag ? { tags: { has: tag } } : {}
        ]
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async create(data: UpsertGroupInput) {
    const username = normalizeUsername(data.username);

    return prisma.group.create({
      data: {
        telegramId: data.telegramId,
        username,
        title: data.title,
        tags: data.tags ?? [],
        isActive: data.isActive ?? true
      }
    });
  }

  async update(id: string, data: UpsertGroupInput) {
    return prisma.group.update({
      where: { id },
      data: {
        title: data.title,
        tags: data.tags,
        isActive: data.isActive
      }
    });
  }

  async remove(id: string) {
    await prisma.group.delete({ where: { id } });
  }

  async syncFromTelegram(accountId: string) {
    const account = await prisma.telegramAccount.findUnique({ where: { id: accountId } });

    if (!account?.encryptedSession) {
      throw new ApiError(400, "Tidak ada akun Telegram yang terhubung untuk sinkronisasi group.");
    }

    const session = decryptText(account.encryptedSession);
    const client = await mtprotoClient.connectFromSession(session);

    try {
      const dialogs = await (client as any).getDialogs({ limit: 500 });
      const rawList = Array.isArray(dialogs)
        ? dialogs
        : Array.isArray((dialogs as any)?.dialogs)
          ? (dialogs as any).dialogs
          : Array.isArray((dialogs as any)?.chats)
            ? (dialogs as any).chats
            : [];

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const groupIds: string[] = [];
      const groupIds: string[] = [];

      for (const item of rawList) {
        const entity = (item as any)?.entity ?? item;
        if (!entity || typeof entity !== "object") {
          skipped += 1;
          continue;
        }

        const className = (entity as { className?: string }).className ?? "";
        if (className !== "Channel" && className !== "Chat") {
          continue;
        }

        const payload = buildGroupFromChat(entity, [], { isActive: undefined });
        if (!payload) {
          skipped += 1;
          continue;
        }

        const status = await this.upsertGroup(payload);
        if (status.status === "created") {
          created += 1;
        } else if (status.status === "updated") {
          updated += 1;
        } else {
          skipped += 1;
        }

        if (status.groupId) {
          groupIds.push(status.groupId);
        }
      }

      const uniqueGroupIds = Array.from(new Set(groupIds));

      await prisma.$transaction(async (tx) => {
        await tx.accountGroup.deleteMany({ where: { accountId } });
        if (uniqueGroupIds.length) {
          await tx.accountGroup.createMany({
            data: uniqueGroupIds.map((groupId) => ({ accountId, groupId })),
            skipDuplicates: true
          });
        }
      });

      await logActivity("groups", "Synced groups from Telegram", "INFO", {
        accountId,
        total: uniqueGroupIds.length,
        created,
        updated,
        skipped
      });

      return {
        accountId,
        total: uniqueGroupIds.length,
        created,
        updated,
        skipped
      };
    } finally {
      await client.disconnect();
    }
  }

  async addUsernamesBatch(usernames: string[], target: "single" | "all", accountId?: string): Promise<BatchAddResult> {
    const normalized = Array.from(new Set(
      usernames
        .map((item) => normalizeUsername(item))
        .filter((item): item is string => Boolean(item))
        .filter((item) => isValidUsername(item))
    ));

    if (!normalized.length) {
      throw new ApiError(400, "Tidak ada username valid untuk diproses.");
    }

    const accounts = target === "all"
      ? await prisma.telegramAccount.findMany({
          where: {
            status: TelegramConnectionStatus.CONNECTED,
            encryptedSession: { not: null }
          },
          orderBy: { updatedAt: "desc" }
        })
      : accountId
        ? await prisma.telegramAccount.findMany({ where: { id: accountId } })
        : [];

    if (!accounts.length) {
      throw new ApiError(400, "Tidak ada akun Telegram yang tersedia untuk batch add.");
    }

    if (target === "single") {
      const chosen = accounts[0];
      if (!chosen?.encryptedSession) {
        throw new ApiError(400, "Akun Telegram yang dipilih belum terhubung.");
      }
    }

    const results: BatchAccountResult[] = [];

    for (const account of accounts) {
      if (!account.encryptedSession) {
        continue;
      }

      const session = decryptText(account.encryptedSession);
      const client = await mtprotoClient.connectFromSession(session);

      try {
        let created = 0;
        let updated = 0;
        let skipped = 0;
        let joined = 0;
        let notFound = 0;
        let joinFailed = 0;
        const groupIds: string[] = [];

        for (const username of normalized) {
          let chat: any = null;
          try {
            const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
            chat = (resolved as any).chats?.[0];
          } catch {
            chat = null;
          }

          if (!chat) {
            notFound += 1;
            continue;
          }

          let joinOk = false;
          try {
            await client.invoke(new Api.channels.JoinChannel({
              channel: new Api.InputChannel({
                channelId: chat.id,
                accessHash: chat.accessHash ?? BigInt(0)
              })
            }));
            joinOk = true;
            joined += 1;
          } catch (joinErr) {
            const errMsg = joinErr instanceof Error ? joinErr.message : String(joinErr);
            if (/already/i.test(errMsg)) {
              joinOk = true;
            } else {
              joinFailed += 1;
            }
          }

          const payload = buildGroupFromChat(chat, [], { isActive: true });
          if (!payload) {
            skipped += 1;
            continue;
          }

          const status = await this.upsertGroup(payload);
          if (status.status === "created") {
            created += 1;
          } else if (status.status === "updated") {
            updated += 1;
          } else {
            skipped += 1;
          }

          if (joinOk && status.groupId) {
            groupIds.push(status.groupId);
          }
        }

        await this.linkAccountGroups(account.id, groupIds);

        results.push({
          accountId: account.id,
          label: account.label,
          phone: account.phone,
          total: normalized.length,
          created,
          updated,
          skipped,
          joined,
          notFound,
          joinFailed
        });
      } finally {
        await client.disconnect();
      }
    }

    const totals = results.reduce(
      (acc, item) => {
        acc.accounts += 1;
        acc.created += item.created;
        acc.updated += item.updated;
        acc.skipped += item.skipped;
        acc.joined += item.joined;
        acc.notFound += item.notFound;
        acc.joinFailed += item.joinFailed;
        return acc;
      },
      { accounts: 0, created: 0, updated: 0, skipped: 0, joined: 0, notFound: 0, joinFailed: 0 }
    );

    await logActivity("groups", "Batch add usernames", "INFO", {
      target,
      usernames: normalized.length,
      accounts: totals.accounts,
      created: totals.created,
      updated: totals.updated,
      joined: totals.joined,
      notFound: totals.notFound,
      joinFailed: totals.joinFailed
    });

    return {
      target,
      totalUsernames: normalized.length,
      accounts: results,
      totals
    };
  }

  async importFromText(content: string, defaultTags: string[]) {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const line of lines) {
      const [rawIdentifier, rawTags] = line.split(";");
      const tagsFromLine = rawTags
        ? rawTags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];

      const { telegramId, username } = parseIdentifier(rawIdentifier);
      if (!telegramId && !username) {
        skipped += 1;
        continue;
      }

      const tags = Array.from(new Set([...defaultTags, ...tagsFromLine]));

      const status = await this.upsertGroup({
        telegramId,
        username,
        tags,
        isActive: true
      });

      if (status.status === "created") {
        created += 1;
      } else if (status.status === "updated") {
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      processed: lines.length,
      created,
      updated,
      skipped
    };
  }

  async importFromFolderLink(link: string, defaultTags: string[], accountId?: string) {
    const slug = extractAddlistSlug(link);
    if (!slug) {
      throw new ApiError(400, "Invalid folder link. Use format https://t.me/addlist/<slug>");
    }

    const account = accountId
      ? await prisma.telegramAccount.findUnique({ where: { id: accountId } })
      : await prisma.telegramAccount.findFirst({
          where: {
            status: TelegramConnectionStatus.CONNECTED,
            encryptedSession: { not: null }
          },
          orderBy: { updatedAt: "desc" }
        });

    if (!account?.encryptedSession) {
      throw new ApiError(400, "No connected Telegram account/session found");
    }

    const session = decryptText(account.encryptedSession);
    const client = await mtprotoClient.connectFromSession(session);

    try {
      const invite = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
      const chats = (invite as { chats?: unknown[] }).chats ?? [];

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const chat of chats) {
        const payload = buildGroupFromChat(chat, defaultTags, { isActive: true });
        if (!payload) {
          skipped += 1;
          continue;
        }

        const status = await this.upsertGroup(payload);
        if (status.status === "created") {
          created += 1;
        } else if (status.status === "updated") {
          updated += 1;
        } else {
          skipped += 1;
        }

        if (status.groupId) {
          groupIds.push(status.groupId);
        }
      }

      await this.linkAccountGroups(account.id, groupIds);

      await logActivity("groups", "Imported groups from folder link", "INFO", {
        slug,
        accountId: account.id,
        processed: chats.length,
        created,
        updated,
        skipped
      });

      return {
        slug,
        processed: chats.length,
        created,
        updated,
        skipped
      };
    } finally {
      await client.disconnect();
    };
  }

  async addByLink(input: string, accountId?: string) {
    const parsed = parseGroupLink(input);
    if (!parsed) {
      throw new ApiError(400, "Link tidak valid. Gunakan @username, link group (t.me/...), atau link addlist (t.me/addlist/...).");
    }

    const account = accountId
      ? await prisma.telegramAccount.findUnique({ where: { id: accountId } })
      : await prisma.telegramAccount.findFirst({
          where: {
            status: TelegramConnectionStatus.CONNECTED,
            encryptedSession: { not: null }
          },
          orderBy: { updatedAt: "desc" }
        });

    if (!account?.encryptedSession) {
      throw new ApiError(400, "Tidak ada akun Telegram yang terhubung. Hubungkan akun terlebih dahulu di menu Session.");
    }

    const session = decryptText(account.encryptedSession);
    const client = await mtprotoClient.connectFromSession(session);

    try {
      if (parsed.type === "addlist") {
        // Folder link → join all chats in the folder + save to DB
        const invite = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug: parsed.value }));
        const chats = (invite as { chats?: unknown[] }).chats ?? [];

        // Actually join the folder
        try {
          const peers: Api.TypeInputPeer[] = [];
          for (const chatVal of chats) {
            if (!chatVal || typeof chatVal !== "object") continue;
            const chat = chatVal as Record<string, unknown>;
            const chatUsername = resolveUsernameFromChat(chat);
            if (chatUsername) {
              try {
                const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: chatUsername }));
                if (resolved.chats && resolved.chats.length > 0) {
                  const ch = resolved.chats[0] as any;
                  if (ch.className === "Channel" || ch.className === "Chat") {
                    peers.push(new Api.InputPeerChannel({ channelId: ch.id, accessHash: ch.accessHash ?? BigInt(0) }));
                  }
                }
              } catch {
                // skip unresolvable
              }
            }
          }
          if (peers.length > 0) {
            await client.invoke(new Api.chatlists.JoinChatlistInvite({ slug: parsed.value, peers }));
          }
        } catch (joinErr) {
          await logActivity("groups", "Folder join attempt (may partially fail)", "WARN", {
            slug: parsed.value,
            error: joinErr instanceof Error ? joinErr.message : String(joinErr)
          });
        }

        let created = 0;
        let updated = 0;
        let skipped = 0;

        const groupIds: string[] = [];
        for (const chat of chats) {
          const payload = buildGroupFromChat(chat, [], { isActive: true });
          if (!payload) { skipped += 1; continue; }
          const status = await this.upsertGroup(payload);
          if (status.status === "created") created += 1;
          else if (status.status === "updated") updated += 1;
          else skipped += 1;

          if (status.groupId) {
            groupIds.push(status.groupId);
          }
        }

        await this.linkAccountGroups(account.id, groupIds);

        await logActivity("groups", "Added groups from folder link with auto-join", "INFO", {
          slug: parsed.value,
          accountId: account.id,
          created,
          updated,
          skipped
        });

        return {
          type: "addlist" as const,
          joined: true,
          created,
          updated,
          skipped,
          total: chats.length
        };
      }

      if (parsed.type === "private_invite") {
        // Private invite link → join via ImportChatInvite + save to DB
        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.value }));
        const updates = result as any;
        const chat = updates.chats?.[0];

        if (!chat) {
          throw new ApiError(400, "Gagal join group. Link invite mungkin sudah expired atau tidak valid.");
        }

        const payload = buildGroupFromChat(chat, [], { isActive: true });
        let status: UpsertGroupResult = { status: "skipped" };
        if (payload) {
          status = await this.upsertGroup(payload);
        }

        if (status.groupId) {
          await this.linkAccountGroups(account.id, [status.groupId]);
        }

        await logActivity("groups", "Joined group via private invite", "INFO", {
          hash: parsed.value.slice(0, 6) + "...",
          accountId: account.id,
          status
        });

        return {
          type: "private_invite" as const,
          joined: true,
          created: status.status === "created" ? 1 : 0,
          updated: status.status === "updated" ? 1 : 0,
          skipped: status.status === "skipped" ? 1 : 0,
          total: 1
        };
      }

      // Username → join via JoinChannel + save to DB
      const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: parsed.value }));
      const chat = (resolved as any).chats?.[0];

      if (!chat) {
        throw new ApiError(400, `Group @${parsed.value} tidak ditemukan di Telegram.`);
      }

      try {
        await client.invoke(new Api.channels.JoinChannel({
          channel: new Api.InputChannel({
            channelId: chat.id,
            accessHash: chat.accessHash ?? BigInt(0)
          })
        }));
      } catch (joinErr) {
        const errMsg = joinErr instanceof Error ? joinErr.message : String(joinErr);
        if (!/already/i.test(errMsg)) {
          await logActivity("groups", "Join channel failed", "WARN", {
            username: parsed.value,
            error: errMsg
          });
        }
      }

      const payload = buildGroupFromChat(chat, [], { isActive: true });
      let status: UpsertGroupResult = { status: "skipped" };
      if (payload) {
        status = await this.upsertGroup(payload);
      }

      if (status.groupId) {
        await this.linkAccountGroups(account.id, [status.groupId]);
      }

      await logActivity("groups", "Joined group via username", "INFO", {
        username: parsed.value,
        accountId: account.id,
        status
      });

      return {
        type: "username" as const,
        joined: true,
        created: status.status === "created" ? 1 : 0,
        updated: status.status === "updated" ? 1 : 0,
        skipped: status.status === "skipped" ? 1 : 0,
        total: 1
      };
    } finally {
      await client.disconnect();
    }
  }
}

export const groupService = new GroupService();
