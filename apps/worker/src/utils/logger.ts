import { prisma } from "../config/prisma";

export const logActivity = async (
  module: string,
  message: string,
  level: "INFO" | "WARN" | "ERROR" = "INFO",
  meta?: unknown
) => {
  try {
    await prisma.activityLog.create({
      data: {
        module,
        message,
        level,
        meta: meta as object | undefined
      }
    });
  } catch {
    // Never let logging crash the broadcast process.
    // If DB is unreachable, just log to console as fallback.
    // eslint-disable-next-line no-console
    console.warn(`[logActivity] DB write failed — ${level} ${module}: ${message}`);
  }
};
