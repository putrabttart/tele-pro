import { SendStatus } from "@prisma/client";
import { stringify } from "csv-stringify/sync";
import { prisma } from "../../config/prisma";

class LogService {
  async listSendLogs(status?: SendStatus) {
    return prisma.sendLog.findMany({
      where: status ? { status } : {},
      include: {
        group: true,
        account: true,
        template: true,
        run: true
      },
      orderBy: {
        timestamp: "desc"
      },
      take: 500
    });
  }

  async listActivityLogs() {
    return prisma.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 500
    });
  }

  async exportSendLogsCsv() {
    const logs = await this.listSendLogs();

    const rows = logs.map((log) => ({
      id: log.id,
      runId: log.runId,
      group: log.group.username ?? log.group.telegramId ?? "unknown",
      account: log.account?.phone ?? "n/a",
      template: log.template?.name ?? "n/a",
      status: log.status,
      errorCode: log.errorCode ?? "",
      errorMessage: log.errorMessage ?? "",
      timestamp: log.timestamp.toISOString()
    }));

    return stringify(rows, {
      header: true
    });
  }
}

export const logService = new LogService();
