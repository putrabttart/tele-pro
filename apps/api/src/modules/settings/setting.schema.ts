import { SendMode } from "@prisma/client";
import { z } from "zod";

const settingBaseSchema = z.object({
  name: z.string().min(1).default("Default"),
  isActive: z.boolean().default(true),
  batchSizeMin: z.number().int().min(1).max(100),
  batchSizeMax: z.number().int().min(1).max(100),
  messageDelayMinSec: z.number().int().min(1).max(3600),
  messageDelayMaxSec: z.number().int().min(1).max(3600),
  batchDelayMinMin: z.number().int().min(0).max(720),
  batchDelayMaxMin: z.number().int().min(0).max(720),
  sendMode: z.nativeEnum(SendMode),
  forwardSourceChatId: z.string().optional(),
  forwardMessageId: z.number().int().optional(),
  forwardMessageLink: z.string().optional(),
  randomizeGroups: z.boolean().default(true),
  autoPauseOnLimit: z.boolean().default(true)
});

export const settingSchema = settingBaseSchema.refine((v) => v.batchSizeMax >= v.batchSizeMin, {
  message: "batchSizeMax must be >= batchSizeMin"
}).refine((v) => v.messageDelayMaxSec >= v.messageDelayMinSec, {
  message: "messageDelayMaxSec must be >= messageDelayMinSec"
}).refine((v) => v.batchDelayMaxMin >= v.batchDelayMinMin, {
  message: "batchDelayMaxMin must be >= batchDelayMinMin"
});

export const updateSettingSchema = settingBaseSchema.partial();
