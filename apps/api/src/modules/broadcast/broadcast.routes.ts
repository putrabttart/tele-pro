import { Router } from "express";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { broadcastController } from "./broadcast.controller";
import { runBroadcastSchema } from "./broadcast.schema";

export const broadcastRoutes = Router();

broadcastRoutes.post("/run", validateBody(runBroadcastSchema), asyncHandler(async (req, res) => {
  await broadcastController.run(req, res);
}));

broadcastRoutes.get("/runs", asyncHandler(async (req, res) => {
  await broadcastController.listRuns(req, res);
}));

broadcastRoutes.get("/busy-accounts", asyncHandler(async (req, res) => {
  await broadcastController.busyAccounts(req, res);
}));

broadcastRoutes.post("/runs/:id/pause", asyncHandler(async (req, res) => {
  await broadcastController.pause(req, res);
}));

broadcastRoutes.post("/runs/:id/resume", asyncHandler(async (req, res) => {
  await broadcastController.resume(req, res);
}));

broadcastRoutes.post("/runs/:id/cancel", asyncHandler(async (req, res) => {
  await broadcastController.cancel(req, res);
}));
