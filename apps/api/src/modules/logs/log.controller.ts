import type { Request, Response } from "express";
import { SendStatus } from "@prisma/client";
import { logService } from "./log.service";

class LogController {
  async sendLogs(req: Request, res: Response) {
    const status = req.query.status as SendStatus | undefined;
    const data = await logService.listSendLogs(status);
    res.json(data);
  }

  async activityLogs(_req: Request, res: Response) {
    const data = await logService.listActivityLogs();
    res.json(data);
  }

  async exportSendLogs(_req: Request, res: Response) {
    const csv = await logService.exportSendLogsCsv();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=send-logs.csv");
    res.send(csv);
  }
}

export const logController = new LogController();
