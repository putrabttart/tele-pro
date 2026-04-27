import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { authController } from "./auth.controller";
import { loginSchema } from "./auth.schema";

export const authRoutes = Router();

authRoutes.post("/login", validateBody(loginSchema), asyncHandler(async (req, res) => {
  authController.login(req, res);
}));

authRoutes.get("/me", authMiddleware, asyncHandler(async (req, res) => {
  authController.me(req, res);
}));
