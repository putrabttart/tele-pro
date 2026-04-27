import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { schedulerController } from "./scheduler.controller";
import { createScheduleSchema } from "./scheduler.schema";

const toggleSchema = z.object({
  isActive: z.boolean()
});

export const schedulerRoutes = Router();

schedulerRoutes.get("/", asyncHandler(async (req, res) => {
  await schedulerController.list(req, res);
}));

schedulerRoutes.post("/", validateBody(createScheduleSchema), asyncHandler(async (req, res) => {
  await schedulerController.create(req, res);
}));

schedulerRoutes.post("/:id/toggle", validateBody(toggleSchema), asyncHandler(async (req, res) => {
  await schedulerController.toggle(req, res);
}));

schedulerRoutes.post("/:id/trigger", asyncHandler(async (req, res) => {
  await schedulerController.trigger(req, res);
}));
