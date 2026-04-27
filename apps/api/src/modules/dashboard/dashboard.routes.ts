import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { dashboardController } from "./dashboard.controller";

export const dashboardRoutes = Router();

dashboardRoutes.get(
  "/overview",
  asyncHandler(async (req, res) => {
    await dashboardController.overview(req, res);
  })
);
