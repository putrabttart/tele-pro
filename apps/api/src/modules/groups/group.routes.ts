import { Router } from "express";
import multer from "multer";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/async-handler";
import { groupController } from "./group.controller";
import {
  addGroupByLinkSchema,
  addGroupBatchSchema,
  createGroupSchema,
  importGroupFolderLinkSchema,
  importGroupTextSchema,
  updateGroupSchema
} from "./group.schema";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 }
});

export const groupRoutes = Router();

groupRoutes.get("/", asyncHandler(async (req, res) => {
  await groupController.list(req, res);
}));

groupRoutes.post("/", validateBody(createGroupSchema), asyncHandler(async (req, res) => {
  await groupController.create(req, res);
}));

groupRoutes.patch("/:id", validateBody(updateGroupSchema), asyncHandler(async (req, res) => {
  await groupController.update(req, res);
}));

groupRoutes.delete("/:id", asyncHandler(async (req, res) => {
  await groupController.remove(req, res);
}));

groupRoutes.post("/add-by-link", validateBody(addGroupByLinkSchema), asyncHandler(async (req, res) => {
  await groupController.addByLink(req, res);
}));

groupRoutes.post("/add-usernames-batch", validateBody(addGroupBatchSchema), asyncHandler(async (req, res) => {
  await groupController.addUsernamesBatch(req, res);
}));

groupRoutes.post("/import/text", validateBody(importGroupTextSchema), asyncHandler(async (req, res) => {
  await groupController.importFromText(req, res);
}));

groupRoutes.post("/import/folder-link", validateBody(importGroupFolderLinkSchema), asyncHandler(async (req, res) => {
  await groupController.importFromFolderLink(req, res);
}));

groupRoutes.post(
  "/import/file",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    await groupController.importFromFile(req, res);
  })
);
