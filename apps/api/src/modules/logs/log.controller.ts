import type { Request, Response } from "express";
import { SendStatus } from "@prisma/client";
import { logService } from "./log.service";

const parseDateParam = (value: unknown, endOfDay = false) => {
  if (typeof value !== "string" || !value.trim()) return undefined;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }

  return date;
};

const parseLimitParam = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

class LogController {
  async sendLogs(req: Request, res: Response) {
    const status = req.query.status as SendStatus | undefined;
    const runId = req.query.runId as string | undefined;
    const cycleNumber = req.query.cycleNumber ? Number(req.query.cycleNumber) : undefined;
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to, true);
    const limit = parseLimitParam(req.query.limit);

    const data = await logService.listSendLogs({ status, runId, cycleNumber, from, to, limit });
    res.json(data);
  }

  async activityLogs(req: Request, res: Response) {
    const runId = req.query.runId as string | undefined;
    const module = req.query.module as string | undefined;

    const data = await logService.listActivityLogs({ runId, module });
    res.json(data);
  }

  /**
   * GET /logs/runs/:runId/cycles
   * Returns per-cycle summary with stats for a specific broadcast run
   */
  async cycleSummary(req: Request, res: Response) {
    const { runId } = req.params;
    const data = await logService.getCycleSummary(runId);

    if (!data) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json(data);
  }

  /**
   * GET /logs/runs/:runId/cycles/:cycleNumber
   * Returns detailed send logs for a specific cycle
   */
  async cycleDetail(req: Request, res: Response) {
    const { runId, cycleNumber } = req.params;
    const cycle = Number(cycleNumber);
    const limit = parseLimitParam(req.query.limit);

    if (!Number.isInteger(cycle) || cycle < 1) {
      res.status(400).json({ error: "Invalid cycle number" });
      return;
    }

    const data = await logService.getLogsForCycle(runId, cycle, limit);
    res.json(data);
  }

  /**
   * GET /logs/runs/:runId/failures
   * Returns failure analysis grouped by error code per cycle
   */
  async failureAnalysis(req: Request, res: Response) {
    const { runId } = req.params;
    const data = await logService.getFailureAnalysis(runId);
    res.json(data);
  }

  async exportSendLogs(req: Request, res: Response) {
    const runId = req.query.runId as string | undefined;
    const status = req.query.status as SendStatus | undefined;
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to, true);
    const limit = parseLimitParam(req.query.limit);
    const csv = await logService.exportSendLogsCsv({ runId, status, from, to, limit });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=send-logs.csv");
    res.send(csv);
  }
}

export const logController = new LogController();
