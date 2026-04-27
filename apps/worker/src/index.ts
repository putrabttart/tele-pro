import { startBroadcastWorker, gracefulShutdown } from "./jobs/broadcast.worker";
import { startSchedulerWorker } from "./jobs/scheduler.worker";

const schedulerTimer = startSchedulerWorker();
const broadcastTimer = startBroadcastWorker();

let shuttingDown = false;

const handleShutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — graceful shutdown...`);

  clearInterval(schedulerTimer);
  clearInterval(broadcastTimer);

  await gracefulShutdown();

  // eslint-disable-next-line no-console
  console.log("Shutdown complete. RUNNING runs will auto-resume on next startup.");
  process.exit(0);
};

process.on("SIGINT", () => void handleShutdown("SIGINT"));
process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

// Handle unexpected crashes — mark RUNNING runs for recovery
process.on("uncaughtException", async (err) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught exception:", err);
  await gracefulShutdown();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled rejection:", reason);
  await gracefulShutdown();
  process.exit(1);
});

// eslint-disable-next-line no-console
console.log("Worker started (Supabase/Postgres queue mode, no Redis)");
