import { Router } from "express";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { createTemplateSchema, updateTemplateSchema } from "./template.schema";
import { templateController } from "./template.controller";

export const templateRoutes = Router();

templateRoutes.get("/", asyncHandler(async (req, res) => {
  await templateController.list(req, res);
}));

templateRoutes.post("/", validateBody(createTemplateSchema), asyncHandler(async (req, res) => {
  await templateController.create(req, res);
}));

templateRoutes.patch("/:id", validateBody(updateTemplateSchema), asyncHandler(async (req, res) => {
  await templateController.update(req, res);
}));

templateRoutes.delete("/:id", asyncHandler(async (req, res) => {
  await templateController.remove(req, res);
}));
