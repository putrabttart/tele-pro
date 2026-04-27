import type { Request, Response } from "express";
import { schedulerService } from "./scheduler.service";

class SchedulerController {
  async list(_req: Request, res: Response) {
    const data = await schedulerService.list();
    res.json(data);
  }

  async create(req: Request, res: Response) {
    const data = await schedulerService.create(req.body);
    res.status(201).json(data);
  }

  async toggle(req: Request, res: Response) {
    const data = await schedulerService.toggle(req.params.id, req.body.isActive);
    res.json(data);
  }

  async trigger(req: Request, res: Response) {
    const data = await schedulerService.triggerNow(req.params.id);
    res.status(202).json(data);
  }
}

export const schedulerController = new SchedulerController();
