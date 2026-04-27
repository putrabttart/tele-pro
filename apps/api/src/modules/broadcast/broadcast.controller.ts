import type { Request, Response } from "express";
import { broadcastService } from "./broadcast.service";

class BroadcastController {
  async run(req: Request, res: Response) {
    const data = await broadcastService.createRun(req.body);
    res.status(202).json(data);
  }

  async listRuns(_req: Request, res: Response) {
    const data = await broadcastService.listRuns();
    res.json(data);
  }

  async pause(req: Request, res: Response) {
    const data = await broadcastService.pauseRun(req.params.id);
    res.json(data);
  }

  async resume(req: Request, res: Response) {
    const data = await broadcastService.resumeRun(req.params.id);
    res.json(data);
  }
}

export const broadcastController = new BroadcastController();
