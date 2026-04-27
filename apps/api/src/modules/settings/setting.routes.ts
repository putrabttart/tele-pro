import { Router } from "express";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { settingController } from "./setting.controller";
import { settingSchema, updateSettingSchema } from "./setting.schema";

export const settingRoutes = Router();

settingRoutes.get("/", asyncHandler(async (req, res) => {
  await settingController.list(req, res);
}));

settingRoutes.get("/current", asyncHandler(async (req, res) => {
  await settingController.current(req, res);
}));

settingRoutes.post("/", validateBody(settingSchema), asyncHandler(async (req, res) => {
  await settingController.create(req, res);
}));

settingRoutes.patch("/:id", validateBody(updateSettingSchema), asyncHandler(async (req, res) => {
  await settingController.update(req, res);
}));
