import { SendStatus, TelegramConnectionStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";

class DashboardService {
  async getOverview() {
    const [connectedCount, disconnectedCount, sent, failed, pending, activeGroups] =
      await prisma.$transaction([
        prisma.telegramAccount.count({ where: { status: TelegramConnectionStatus.CONNECTED } }),
        prisma.telegramAccount.count({ where: { status: TelegramConnectionStatus.DISCONNECTED } }),
        prisma.sendLog.count({ where: { status: SendStatus.SUCCESS } }),
        prisma.sendLog.count({ where: { status: SendStatus.FAILED } }),
        prisma.sendLog.count({ where: { status: SendStatus.PENDING } }),
        prisma.group.count({ where: { isActive: true } })
      ]);

    return {
      telegram: {
        status: connectedCount > 0 ? "connected" : "disconnected",
        connectedCount,
        disconnectedCount
      },
      stats: {
        totalSent: sent,
        failed,
        pending,
        activeGroups
      }
    };
  }
}

export const dashboardService = new DashboardService();
