export type DashboardOverview = {
  telegram: {
    status: "connected" | "disconnected";
    connectedCount: number;
    disconnectedCount: number;
  };
  stats: {
    totalSent: number;
    failed: number;
    pending: number;
    activeGroups: number;
  };
};

export type GroupItem = {
  id: string;
  telegramId: string | null;
  username: string | null;
  title: string | null;
  isActive: boolean;
  tags: string[];
};

export type TemplateItem = {
  id: string;
  name: string;
  text: string;
  mediaUrl: string | null;
  spinEnabled: boolean;
  isActive: boolean;
};

export type SettingItem = {
  id: string;
  name: string;
  isActive: boolean;
  batchSizeMin: number;
  batchSizeMax: number;
  messageDelayMinSec: number;
  messageDelayMaxSec: number;
  batchDelayMinMin: number;
  batchDelayMaxMin: number;
  sendMode: "NEW_MESSAGE" | "FORWARD";
  forwardSourceChatId: string | null;
  forwardMessageId: number | null;
  randomizeGroups: boolean;
  autoPauseOnLimit: boolean;
};

export type ScheduleItem = {
  id: string;
  name: string;
  type: "MANUAL" | "INTERVAL" | "CRON";
  intervalHours: number | null;
  cronExpr: string | null;
  isActive: boolean;
  settingId: string;
};

export type TelegramAccount = {
  id: string;
  label: string;
  phone: string;
  status: "CONNECTED" | "DISCONNECTED" | "PENDING";
  lastLoginAt: string | null;
};

export type CycleDetail = {
  cycleNumber: number;
  status: "completed" | "paused" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sent: number;
  failed: number;
  skipped: number;
  failReason?: string;
};

export type RunItem = {
  id: string;
  label: string | null;
  status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  totalGroups: number;
  reason: string | null;
  requestedAccountId: string | null;
  requestedTemplateIds: string[];
  totalDurationHours: number | null;
  intervalMinutes: number | null;
  completedCycles: number;
  currentCycleNumber: number;
  currentCycleStartedAt: string | null;
  lastCycleFinishedAt: string | null;
  nextCycleAt: string | null;
  consecutiveFailCount: number;
  cycleDetails: CycleDetail[] | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BusyAccountInfo = {
  accountId: string;
  runId: string;
  runLabel: string | null;
  runStatus: "PENDING" | "RUNNING" | "PAUSED";
};

export type SendLogItem = {
  id: string;
  runId: string;
  cycleNumber: number;
  status: "SUCCESS" | "FAILED" | "PENDING" | "SKIPPED";
  errorCode: string | null;
  errorMessage: string | null;
  timestamp: string;
  group: {
    username: string | null;
    telegramId: string | null;
    title: string | null;
  };
  account: {
    id: string;
    label: string;
    phone: string;
  } | null;
  run: {
    id: string;
    label: string | null;
    status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";
    requestedAccountId: string | null;
    completedCycles: number;
    totalDurationHours: number | null;
    intervalMinutes: number | null;
    createdAt: string;
  } | null;
};

export type CycleSummaryResponse = {
  run: {
    id: string;
    status: string;
    completedCycles: number;
    currentCycleNumber: number;
    totalDurationHours: number | null;
    intervalMinutes: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    sentCount: number;
    failedCount: number;
    totalGroups: number;
    currentCycleStartedAt: string | null;
    lastCycleFinishedAt: string | null;
    nextCycleAt: string | null;
    consecutiveFailCount: number;
    reason: string | null;
    cycleDetails: CycleDetail[] | null;
  };
  cycles: Array<{
    cycleNumber: number;
    total: number;
    success: number;
    failed: number;
    firstSent: string | null;
    lastSent: string | null;
    durationMs: number | null;
  }>;
};

export type FailureAnalysis = Array<{
  errorCode: string | null;
  errorMessage: string | null;
  cycleNumber: number;
  count: number;
}>;
