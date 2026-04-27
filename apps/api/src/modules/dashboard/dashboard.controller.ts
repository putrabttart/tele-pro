import type { Request, Response } from "express";
import { dashboardService } from "./dashboard.service";

class DashboardController {
  async overview(_req: Request, res: Response) {
    const result = await dashboardService.getOverview();
    res.json(result);
  }
}

export const dashboardController = new DashboardController();
