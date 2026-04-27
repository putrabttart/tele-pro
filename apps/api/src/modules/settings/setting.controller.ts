import type { Request, Response } from "express";
import { SendMode } from "@prisma/client";
import { settingService } from "./setting.service";
import { ApiError } from "../../utils/api-error";
import { parseForwardMessageLink } from "../../utils/telegram-links";

const normalizeSettingPayload = (body: Record<string, unknown>) => {
  const payload = { ...body } as Record<string, unknown>;
  const rawForwardLink = typeof payload.forwardMessageLink === "string" ? payload.forwardMessageLink.trim() : "";

  if (rawForwardLink) {
    const parsed = parseForwardMessageLink(rawForwardLink);
    if (!parsed) {
      throw new ApiError(400, "Invalid forward message link. Example: https://t.me/channel_username/70");
    }

    payload.forwardSourceChatId = parsed.forwardSourceChatId;
    payload.forwardMessageId = parsed.forwardMessageId;
  }

  if (payload.sendMode === SendMode.FORWARD && (!payload.forwardSourceChatId || !payload.forwardMessageId)) {
    throw new ApiError(400, "FORWARD mode requires source chat and message id (or forward message link)");
  }

  delete payload.forwardMessageLink;
  return payload;
};

class SettingController {
  async list(_req: Request, res: Response) {
    const data = await settingService.list();
    res.json(data);
  }

  async current(_req: Request, res: Response) {
    const data = await settingService.getOrCreateDefault();
    res.json(data);
  }

  async create(req: Request, res: Response) {
    const payload = normalizeSettingPayload(req.body as Record<string, unknown>);
    const data = await settingService.create(payload as Parameters<typeof settingService.create>[0]);
    res.status(201).json(data);
  }

  async update(req: Request, res: Response) {
    const payload = normalizeSettingPayload(req.body as Record<string, unknown>);
    const data = await settingService.update(req.params.id, payload as Parameters<typeof settingService.update>[1]);
    res.json(data);
  }
}

export const settingController = new SettingController();
