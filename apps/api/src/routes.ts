import type { Express } from "express";
import { authMiddleware } from "./middleware/auth";
import { authRoutes } from "./modules/auth/auth.routes";
import { broadcastRoutes } from "./modules/broadcast/broadcast.routes";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes";
import { groupRoutes } from "./modules/groups/group.routes";
import { logRoutes } from "./modules/logs/log.routes";
import { schedulerRoutes } from "./modules/scheduler/scheduler.routes";
import { settingRoutes } from "./modules/settings/setting.routes";
import { telegramRoutes } from "./modules/telegram/telegram.routes";
import { templateRoutes } from "./modules/templates/template.routes";

export const registerRoutes = (app: Express) => {
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);

  app.use("/api/dashboard", authMiddleware, dashboardRoutes);
  app.use("/api/groups", authMiddleware, groupRoutes);
  app.use("/api/templates", authMiddleware, templateRoutes);
  app.use("/api/settings", authMiddleware, settingRoutes);
  app.use("/api/broadcast", authMiddleware, broadcastRoutes);
  app.use("/api/scheduler", authMiddleware, schedulerRoutes);
  app.use("/api/telegram", authMiddleware, telegramRoutes);
  app.use("/api/logs", authMiddleware, logRoutes);
};
