import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { logController } from "./log.controller";

export const logRoutes = Router();

logRoutes.get("/send", asyncHandler(async (req, res) => {
  await logController.sendLogs(req, res);
}));

logRoutes.get("/activity", asyncHandler(async (req, res) => {
  await logController.activityLogs(req, res);
}));

logRoutes.get("/send/export", asyncHandler(async (req, res) => {
  await logController.exportSendLogs(req, res);
}));
