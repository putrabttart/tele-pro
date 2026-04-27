import type { Request, Response } from "express";
import { templateService } from "./template.service";

class TemplateController {
  async list(_req: Request, res: Response) {
    const data = await templateService.list();
    res.json(data);
  }

  async create(req: Request, res: Response) {
    const data = await templateService.create(req.body);
    res.status(201).json(data);
  }

  async update(req: Request, res: Response) {
    const data = await templateService.update(req.params.id, req.body);
    res.json(data);
  }

  async remove(req: Request, res: Response) {
    await templateService.remove(req.params.id);
    res.status(204).send();
  }
}

export const templateController = new TemplateController();
