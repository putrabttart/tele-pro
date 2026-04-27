import { RunStatus, ScheduleType, SendMode } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { logActivity } from "../utils/logger";

const MODE_MARKER_PREFIX = "__TBM_MODE:";
const FORWARD_SOURCE_MARKER_PREFIX = "__TBM_FORWARD_SOURCE:";
const FORWARD_MESSAGE_MARKER_PREFIX = "__TBM_FORWARD_MESSAGE_ID:";

const toNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const matchesCronField = (field: string, value: number, min: number, max: number) => {
  return field.split(",").some((segment) => {
    const part = segment.trim();
    if (!part) {
      return false;
    }

    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? toNumber(stepPart) : 1;

    if (!step || step < 1) {
      return false;
    }

    let rangeStart = min;
    let rangeEnd = max;

    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [start, end] = rangePart.split("-").map((item) => toNumber(item));
        if (start === null || end === null) {
          return false;
        }
        rangeStart = start;
        rangeEnd = end;
      } else {
        const exact = toNumber(rangePart);
        if (exact === null) {
          return false;
        }
        rangeStart = exact;
        rangeEnd = exact;
      }
    }

    if (value < rangeStart || value > rangeEnd) {
      return false;
    }

    return (value - rangeStart) % step === 0;
  });
};

const matchesCronExpression = (expression: string, date: Date) => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  return (
    matchesCronField(minuteField, date.getMinutes(), 0, 59) &&
    matchesCronField(hourField, date.getHours(), 0, 23) &&
    matchesCronField(dayOfMonthField, date.getDate(), 1, 31) &&
    matchesCronField(monthField, date.getMonth() + 1, 1, 12) &&
    matchesCronField(dayOfWeekField, date.getDay(), 0, 6)
  );
};

const isSameMinute = (a: Date, b: Date) => {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
};

const shouldTrigger = (schedule: {
  type: ScheduleType;
  intervalHours: number | null;
  cronExpr: string | null;
  lastRunAt: Date | null;
}, now: Date) => {
  if (schedule.type === ScheduleType.MANUAL) {
    return false;
  }

  if (schedule.type === ScheduleType.INTERVAL) {
    if (!schedule.intervalHours) {
      return false;
    }

    if (!schedule.lastRunAt) {
      return true;
    }

    return now.getTime() - schedule.lastRunAt.getTime() >= schedule.intervalHours * 60 * 60 * 1000;
  }

  if (!schedule.cronExpr) {
    return false;
  }

  const matched = matchesCronExpression(schedule.cronExpr, now);
  if (!matched) {
    return false;
  }

  if (!schedule.lastRunAt) {
    return true;
  }

  return !isSameMinute(schedule.lastRunAt, now);
};

const createRunFromSchedule = async (scheduleId: string) => {
  const schedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { setting: true }
  });

  if (!schedule || !schedule.isActive) {
    await logActivity("worker", "Skipping inactive/missing schedule", "WARN", { scheduleId });
    return;
  }

  if (schedule.type === ScheduleType.MANUAL) {
    await logActivity("worker", "Manual schedule skipped by automatic scheduler poller", "WARN", {
      scheduleId
    });
    return;
  }

  const activeRun = await prisma.broadcastRun.findFirst({
    where: {
      scheduleId: schedule.id,
      status: {
        in: [RunStatus.PENDING, RunStatus.RUNNING]
      }
    }
  });

  if (activeRun) {
    return;
  }

  let requestedTemplateIds: string[] = [];

  if (schedule.setting.sendMode === SendMode.FORWARD) {
    if (!schedule.setting.forwardSourceChatId) {
      await logActivity("worker", "Skipping schedule due to missing forward source", "WARN", {
        scheduleId: schedule.id
      });
      return;
    }

    requestedTemplateIds = [
      `${MODE_MARKER_PREFIX}FORWARD_LINK`,
      `${FORWARD_SOURCE_MARKER_PREFIX}${schedule.setting.forwardSourceChatId}`
    ];

    if (schedule.setting.forwardMessageId) {
      requestedTemplateIds.push(`${FORWARD_MESSAGE_MARKER_PREFIX}${schedule.setting.forwardMessageId}`);
    }
  } else {
    await logActivity(
      "worker",
      "Skipping schedule in NEW_MESSAGE mode (manual run payload required)",
      "WARN",
      {
        scheduleId: schedule.id
      }
    );
    return;
  }

  await prisma.broadcastRun.create({
    data: {
      scheduleId: schedule.id,
      settingId: schedule.settingId,
      requestedTemplateIds,
      status: RunStatus.PENDING
    }
  }).then(async (run) => {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date() }
    });

    await logActivity("worker", "Schedule triggered run", "INFO", {
      scheduleId: schedule.id,
      runId: run.id
    });
  });
};

let processing = false;

const processTick = async () => {
  if (processing) {
    return;
  }

  processing = true;
  try {
    const now = new Date();
    const schedules = await prisma.schedule.findMany({
      where: {
        isActive: true,
        type: {
          in: [ScheduleType.INTERVAL, ScheduleType.CRON]
        }
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    for (const schedule of schedules) {
      if (shouldTrigger(schedule, now)) {
        await createRunFromSchedule(schedule.id);
      }
    }
  } catch (error) {
    await logActivity("worker", "Scheduler tick failed", "ERROR", {
      message: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    processing = false;
  }
};

export const startSchedulerWorker = () => {
  void processTick();
  return setInterval(() => {
    void processTick();
  }, env.SCHEDULE_POLL_INTERVAL_MS);
};
