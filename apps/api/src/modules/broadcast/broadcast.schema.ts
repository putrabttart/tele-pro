import { z } from "zod";

const runBaseSchema = z.object({
  settingId: z.string().optional(),
  scheduleId: z.string().optional(),
  accountId: z.string().optional(),
  totalDurationHours: z.number().int().min(1).optional(),
  intervalMinutes: z.number().int().min(1).optional()
});

const runDirectTextSchema = runBaseSchema.extend({
  mode: z.literal("DIRECT_TEXT"),
  messageText: z.string().trim().min(1)
});

const runForwardLinkSchema = runBaseSchema.extend({
  mode: z.literal("FORWARD_LINK"),
  messageLink: z.string().trim().min(1)
});

export const runBroadcastSchema = z.discriminatedUnion("mode", [runDirectTextSchema, runForwardLinkSchema]);
