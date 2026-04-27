import { prisma } from "../config/prisma";

export const logActivity = async (
  module: string,
  message: string,
  level: "INFO" | "WARN" | "ERROR" = "INFO",
  meta?: unknown
) => {
  await prisma.activityLog.create({
    data: {
      module,
      message,
      level,
      meta: meta as object | undefined
    }
  });
};
