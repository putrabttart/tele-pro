import { ScheduleType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { broadcastService } from "../broadcast/broadcast.service";

class SchedulerService {
  async list() {
    return prisma.schedule.findMany({
      include: { setting: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async create(data: {
    name: string;
    type: ScheduleType;
    intervalHours?: number;
    cronExpr?: string;
    isActive: boolean;
    settingId: string;
  }) {
    const schedule = await prisma.schedule.create({
      data: {
        name: data.name,
        type: data.type,
        intervalHours: data.intervalHours,
        cronExpr: data.cronExpr,
        isActive: data.isActive,
        settingId: data.settingId
      }
    });

    return schedule;
  }

  async toggle(id: string, isActive: boolean) {
    const existing = await prisma.schedule.findUnique({ where: { id } });
    if (!existing) {
      throw new Error("Schedule not found");
    }

    const schedule = await prisma.schedule.update({
      where: { id },
      data: { isActive }
    });

    return schedule;
  }

  async triggerNow(id: string) {
    const schedule = await prisma.schedule.findUnique({ where: { id } });
    if (!schedule) {
      throw new Error("Schedule not found");
    }

    const run = await broadcastService.createRun({
      scheduleId: schedule.id,
      settingId: schedule.settingId
    });

    await prisma.schedule.update({
      where: { id },
      data: { lastRunAt: new Date() }
    });

    return run;
  }
}

export const schedulerService = new SchedulerService();
