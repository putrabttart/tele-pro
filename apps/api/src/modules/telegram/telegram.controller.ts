import type { Request, Response } from "express";
import { telegramService } from "./telegram.service";

class TelegramController {
  async list(_req: Request, res: Response) {
    const data = await telegramService.listAccounts();
    res.json(data);
  }

  async requestOtp(req: Request, res: Response) {
    const data = await telegramService.requestOtp(req.body.phone, req.body.label);
    res.json(data);
  }

  async verifyOtp(req: Request, res: Response) {
    const data = await telegramService.verifyOtp(req.body.phone, req.body.code);
    res.json(data);
  }

  async disconnect(req: Request, res: Response) {
    const data = await telegramService.disconnect(req.params.id);
    res.json(data);
  }

  async testSession(req: Request, res: Response) {
    const data = await telegramService.testSession(req.params.id);
    res.json(data);
  }
}

export const telegramController = new TelegramController();
