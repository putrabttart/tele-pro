import { Router } from "express";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { telegramController } from "./telegram.controller";
import { requestOtpSchema, verifyOtpSchema } from "./telegram.schema";

export const telegramRoutes = Router();

telegramRoutes.get("/accounts", asyncHandler(async (req, res) => {
  await telegramController.list(req, res);
}));

telegramRoutes.post("/request-otp", validateBody(requestOtpSchema), asyncHandler(async (req, res) => {
  await telegramController.requestOtp(req, res);
}));

telegramRoutes.post("/verify-otp", validateBody(verifyOtpSchema), asyncHandler(async (req, res) => {
  await telegramController.verifyOtp(req, res);
}));

telegramRoutes.post("/accounts/:id/disconnect", asyncHandler(async (req, res) => {
  await telegramController.disconnect(req, res);
}));

telegramRoutes.get("/accounts/:id/test", asyncHandler(async (req, res) => {
  await telegramController.testSession(req, res);
}));
