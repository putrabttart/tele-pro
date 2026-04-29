import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { logController } from "./log.controller";

export const logRoutes = Router();

// ── Send Logs ──
logRoutes.get("/send", asyncHandler(async (req, res) => {
  await logController.sendLogs(req, res);
}));

// ── Activity Logs ──
logRoutes.get("/activity", asyncHandler(async (req, res) => {
  await logController.activityLogs(req, res);
}));

// ── Per-Cycle Summary for a Run ──
logRoutes.get("/runs/:runId/cycles", asyncHandler(async (req, res) => {
  await logController.cycleSummary(req, res);
}));

// ── Detailed logs for a specific cycle ──
logRoutes.get("/runs/:runId/cycles/:cycleNumber", asyncHandler(async (req, res) => {
  await logController.cycleDetail(req, res);
}));

// ── Failure analysis for a run ──
logRoutes.get("/runs/:runId/failures", asyncHandler(async (req, res) => {
  await logController.failureAnalysis(req, res);
}));

// ── Export CSV ──
logRoutes.get("/send/export", asyncHandler(async (req, res) => {
  await logController.exportSendLogs(req, res);
}));
