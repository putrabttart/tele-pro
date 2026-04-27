import { ScheduleType } from "@prisma/client";
import { z } from "zod";

export const createScheduleSchema = z.object({
  name: z.string().min(1),
  type: z.nativeEnum(ScheduleType),
  intervalHours: z.number().int().min(1).optional(),
  cronExpr: z.string().optional(),
  isActive: z.boolean().default(true),
  settingId: z.string().min(1)
}).superRefine((value, ctx) => {
  if (value.type === ScheduleType.INTERVAL && !value.intervalHours) {
    ctx.addIssue({
      code: "custom",
      message: "intervalHours is required for INTERVAL"
    });
  }

  if (value.type === ScheduleType.CRON && !value.cronExpr) {
    ctx.addIssue({
      code: "custom",
      message: "cronExpr is required for CRON"
    });
  }
});
