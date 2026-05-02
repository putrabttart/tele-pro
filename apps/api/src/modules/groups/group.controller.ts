import type { Request, Response } from "express";
import { ApiError } from "../../utils/api-error";
import { groupService } from "./group.service";

class GroupController {
  async list(req: Request, res: Response) {
    const search = req.query.search as string | undefined;
    const tag = req.query.tag as string | undefined;
    const accountId = req.query.accountId as string | undefined;
    const sync = req.query.sync === "1" || req.query.sync === "true";

    if (sync) {
      if (!accountId) {
        throw new ApiError(400, "accountId wajib diisi untuk sync group");
      }
      await groupService.syncFromTelegram(accountId);
    }

    const data = await groupService.list(search, tag, accountId);
    res.json(data);
  }

  async create(req: Request, res: Response) {
    const created = await groupService.create(req.body);
    res.status(201).json(created);
  }

  async update(req: Request, res: Response) {
    const updated = await groupService.update(req.params.id, req.body);
    res.json(updated);
  }

  async remove(req: Request, res: Response) {
    await groupService.remove(req.params.id);
    res.status(204).send();
  }

  async importFromText(req: Request, res: Response) {
    const result = await groupService.importFromText(req.body.content, req.body.defaultTags ?? []);
    res.json(result);
  }

  async importFromFile(req: Request, res: Response) {
    if (!req.file) {
      throw new ApiError(400, "Missing file");
    }

    const content = req.file.buffer.toString("utf8");
    const rawTags = typeof req.body.defaultTags === "string" ? req.body.defaultTags : "";
    const defaultTags = rawTags
      .split(",")
      .map((tag: string) => tag.trim())
      .filter(Boolean);

    const result = await groupService.importFromText(content, defaultTags);
    res.json(result);
  }

  async importFromFolderLink(req: Request, res: Response) {
    const result = await groupService.importFromFolderLink(
      req.body.link,
      req.body.defaultTags ?? [],
      req.body.accountId
    );

    res.json(result);
  }

  async addByLink(req: Request, res: Response) {
    const result = await groupService.addByLink(req.body.input, req.body.accountId);
    res.json(result);
  }

  async addUsernamesBatch(req: Request, res: Response) {
    const { usernames, target, accountId } = req.body as {
      usernames: string[];
      target: "single" | "all";
      accountId?: string;
    };

    if (target === "single" && !accountId) {
      throw new ApiError(400, "accountId wajib diisi untuk target single");
    }

    const result = await groupService.addUsernamesBatch(usernames, target, accountId);
    res.json(result);
  }
}

export const groupController = new GroupController();
