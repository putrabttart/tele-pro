import { prisma } from "../../config/prisma";

class SettingService {
  async list() {
    return prisma.broadcastSetting.findMany({
      orderBy: { createdAt: "desc" }
    });
  }

  async getOrCreateDefault() {
    const existing = await prisma.broadcastSetting.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "asc" }
    });

    if (existing) {
      return existing;
    }

    return prisma.broadcastSetting.create({
      data: {
        name: "Default",
        batchSizeMin: 10,
        batchSizeMax: 30,
        messageDelayMinSec: 20,
        messageDelayMaxSec: 90,
        batchDelayMinMin: 30,
        batchDelayMaxMin: 180,
        randomizeGroups: true,
        autoPauseOnLimit: true
      }
    });
  }

  async create(data: {
    name: string;
    isActive: boolean;
    batchSizeMin: number;
    batchSizeMax: number;
    messageDelayMinSec: number;
    messageDelayMaxSec: number;
    batchDelayMinMin: number;
    batchDelayMaxMin: number;
    sendMode: "NEW_MESSAGE" | "FORWARD";
    forwardSourceChatId?: string;
    forwardMessageId?: number;
    randomizeGroups: boolean;
    autoPauseOnLimit: boolean;
  }) {
    if (data.isActive) {
      await prisma.broadcastSetting.updateMany({
        where: { isActive: true },
        data: { isActive: false }
      });
    }

    return prisma.broadcastSetting.create({
      data
    });
  }

  async update(id: string, data: Partial<{
    name: string;
    isActive: boolean;
    batchSizeMin: number;
    batchSizeMax: number;
    messageDelayMinSec: number;
    messageDelayMaxSec: number;
    batchDelayMinMin: number;
    batchDelayMaxMin: number;
    sendMode: "NEW_MESSAGE" | "FORWARD";
    forwardSourceChatId: string;
    forwardMessageId: number;
    randomizeGroups: boolean;
    autoPauseOnLimit: boolean;
  }>) {
    if (data.isActive) {
      await prisma.broadcastSetting.updateMany({
        where: {
          id: { not: id },
          isActive: true
        },
        data: { isActive: false }
      });
    }

    return prisma.broadcastSetting.update({
      where: { id },
      data
    });
  }
}

export const settingService = new SettingService();
