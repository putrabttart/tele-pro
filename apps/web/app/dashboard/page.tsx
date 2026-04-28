"use client";

import "./dashboard.css";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiBaseUrl, apiFetch, clearToken, getToken } from "../../lib/api";
import type {
  BusyAccountInfo,
  DashboardOverview,
  GroupItem,
  RunItem,
  ScheduleItem,
  SendLogItem,
  SettingItem,
  TelegramAccount,
  TemplateItem
} from "../../types";

type DashboardSectionId =
  | "overview"
  | "session"
  | "groups"
  | "templates"
  | "broadcast"
  | "monitoring";

const sectionMeta: Array<{
  id: DashboardSectionId;
  label: string;
  subtitle: string;
  icon: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    subtitle: "Ringkasan status sistem",
    icon: "bi-speedometer2"
  },
  {
    id: "session",
    label: "Session Telegram",
    subtitle: "Request & verify OTP",
    icon: "bi-phone"
  },
  {
    id: "groups",
    label: "Manage Group",
    subtitle: "List group + link addlist",
    icon: "bi-people"
  },
  {
    id: "templates",
    label: "Templates",
    subtitle: "Text/media + spin text",
    icon: "bi-file-earmark-text"
  },
  {
    id: "broadcast",
    label: "Broadcast",
    subtitle: "Teks langsung atau forward link",
    icon: "bi-send"
  },
  {
    id: "monitoring",
    label: "Monitoring",
    subtitle: "Scheduler + alasan gagal",
    icon: "bi-activity"
  }
];

const sectionGroups: Array<{
  label: string;
  items: DashboardSectionId[];
}> = [
  {
    label: "Menu",
    items: ["overview", "session", "groups"]
  },
  {
    label: "Support",
    items: ["templates", "broadcast"]
  },
  {
    label: "Monitoring",
    items: ["monitoring"]
  }
];

type OverviewKpiCard = {
  id: string;
  icon: string;
  label: string;
  value: string;
  helper: string;
  trend: number;
  inverse?: boolean;
};

type MonthlySeriesPoint = {
  label: string;
  sent: number;
  failed: number;
};

type WeeklySeriesPoint = {
  label: string;
  sent: number;
  failed: number;
};

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdayLabels = ["M", "T", "W", "T", "F", "S", "S"];

const compactNumberFormatter = new Intl.NumberFormat("id-ID", {
  notation: "compact",
  maximumFractionDigits: 1
});

const percentNumberFormatter = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 1
});

const formatCompactNumber = (value: number) => {
  return compactNumberFormatter.format(value);
};

const formatTrend = (value: number) => {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${safeValue >= 0 ? "+" : ""}${percentNumberFormatter.format(safeValue)}%`;
};

const calculateDeltaPercent = (current: number, previous: number) => {
  if (previous <= 0) {
    return current > 0 ? 100 : 0;
  }

  return ((current - previous) / previous) * 100;
};

const defaultSettingForm = {
  name: "Default",
  messageDelaySec: 20,
  randomizeGroups: true,
  autoPauseOnLimit: true,
  isActive: true
};

const mapSettingToForm = (setting: SettingItem) => {
  return {
    name: setting.name,
    messageDelaySec: setting.messageDelayMinSec,
    randomizeGroups: setting.randomizeGroups,
    autoPauseOnLimit: setting.autoPauseOnLimit,
    isActive: setting.isActive
  };
};

type ParsedReason = {
  title: string;
  description: string;
  suggestion: string;
  icon: string;
  severity: "critical" | "warning" | "info";
};

const parseRunReason = (reason: string | null): ParsedReason => {
  if (!reason) {
    return {
      title: "Tidak ada informasi",
      description: "Sistem tidak mencatat alasan kegagalan untuk run ini.",
      suggestion: "Cek log aktivitas untuk detail lebih lanjut.",
      icon: "bi-question-circle",
      severity: "info"
    };
  }

  const lower = reason.toLowerCase();

  if (lower.includes("no connected telegram account") || lower.includes("no connected telegram")) {
    return {
      title: "Akun Telegram Tidak Terhubung",
      description: "Tidak ada akun Telegram dengan status CONNECTED yang bisa digunakan untuk mengirim pesan.",
      suggestion: "Buka menu Session Telegram, lakukan Request OTP dan Verify OTP sampai status akun menjadi CONNECTED.",
      icon: "bi-phone-vibrate",
      severity: "critical"
    };
  }

  if (lower.includes("direct_text") && lower.includes("non-empty")) {
    return {
      title: "Pesan Teks Kosong",
      description: "Mode Direct Message dipilih, tetapi isi pesan teks tidak diisi atau kosong.",
      suggestion: "Saat menjalankan broadcast, pastikan kolom pesan sudah diisi dengan teks yang ingin dikirim.",
      icon: "bi-chat-left-text",
      severity: "critical"
    };
  }

  if (lower.includes("forward") && lower.includes("source chat")) {
    return {
      title: "Sumber Forward Tidak Ditemukan",
      description: "Mode Forward dipilih, tetapi link sumber pesan (source chat) tidak tersedia atau tidak valid.",
      suggestion: "Pastikan link Telegram yang diisi valid dan berisi pesan yang bisa di-forward.",
      icon: "bi-forward",
      severity: "critical"
    };
  }

  if (lower.includes("no active groups")) {
    return {
      title: "Tidak Ada Group Aktif",
      description: "Tidak ditemukan group dengan status aktif sebagai target broadcast.",
      suggestion: "Buka menu Manage Group, tambahkan group baru atau aktifkan group yang sudah ada.",
      icon: "bi-people",
      severity: "critical"
    };
  }

  if (lower.includes("floodwait")) {
    const match = reason.match(/(\d+)\s*s/i);
    const seconds = match ? match[1] : "?";
    return {
      title: "Rate Limit Telegram (FloodWait)",
      description: `Telegram membatasi pengiriman karena terlalu banyak pesan dalam waktu singkat. Waktu tunggu: ${seconds} detik.`,
      suggestion: "Broadcast otomatis di-pause. Tunggu sampai waktu limit habis, atau tingkatkan delay antar pesan di Broadcast Setting.",
      icon: "bi-hourglass-split",
      severity: "warning"
    };
  }

  if (lower.includes("peerflood")) {
    return {
      title: "Spam Detection (PeerFlood)",
      description: "Telegram mendeteksi aktivitas spam dari akun ini dan memblokir pengiriman pesan sementara.",
      suggestion: "Hentikan broadcast sementara. Tunggu beberapa jam sebelum mencoba lagi. Pertimbangkan untuk menambah delay antar pesan.",
      icon: "bi-shield-exclamation",
      severity: "critical"
    };
  }

  if (lower.includes("semua") && lower.includes("siklus selesai")) {
    const cycleMatch = reason.match(/(\d+)\s+siklus/i);
    const cycle = cycleMatch ? cycleMatch[1] : "?";
    return {
      title: `Semua ${cycle} Siklus Selesai`,
      description: `Broadcast batch telah menyelesaikan semua ${cycle} siklus yang dijadwalkan.`,
      suggestion: "Broadcast selesai sesuai target. Buat broadcast baru jika ingin mengirim lagi.",
      icon: "bi-check-circle",
      severity: "info"
    };
  }

  if (lower.includes("cycle") && lower.includes("completed") && lower.includes("waiting")) {
    const cycleMatch = reason.match(/cycle\s+(\d+)(?:\/(\d+))?/i);
    const waitMatch = reason.match(/waiting\s+(\d+)\s*min/i);
    const cycle = cycleMatch ? cycleMatch[1] : "?";
    const maxCycle = cycleMatch?.[2] ?? null;
    const waitMin = waitMatch ? waitMatch[1] : "?";
    return {
      title: `Menunggu Siklus Berikutnya`,
      description: maxCycle
        ? `Siklus ke-${cycle} dari ${maxCycle} sudah selesai. Menunggu ${waitMin} menit sebelum siklus ke-${Number(cycle) + 1}.`
        : `Siklus ke-${cycle} sudah selesai. Menunggu ${waitMin} menit sebelum siklus berikutnya.`,
      suggestion: "Ini normal untuk mode batch broadcast. Broadcast akan otomatis lanjut setelah waktu tunggu habis. Kamu bisa pause jika ingin menunda.",
      icon: "bi-hourglass-split",
      severity: "info"
    };
  }

  if (lower.includes("dihentikan oleh user")) {
    return {
      title: "Dihentikan oleh User",
      description: "Broadcast ini dihentikan secara manual oleh user.",
      suggestion: "Jika ingin mengirim ulang, buat broadcast baru dari menu Broadcast.",
      icon: "bi-stop-circle",
      severity: "warning"
    };
  }

  if (lower.includes("auto-recovered") || lower.includes("server restart")) {
    return {
      title: "Pemulihan Otomatis",
      description: reason,
      suggestion: "Server mengalami restart. Broadcast akan otomatis dilanjutkan dari posisi terakhir.",
      icon: "bi-arrow-clockwise",
      severity: "warning"
    };
  }

  if (lower.includes("server shutdown")) {
    return {
      title: "Server Shutdown",
      description: "Server sedang shutdown. Broadcast akan otomatis dilanjutkan saat server nyala kembali.",
      suggestion: "Tidak perlu tindakan. Broadcast akan resume otomatis.",
      icon: "bi-power",
      severity: "warning"
    };
  }

  return {
    title: "Broadcast Gagal",
    description: reason,
    suggestion: "Periksa detail error di atas dan coba perbaiki masalahnya sebelum menjalankan broadcast ulang.",
    icon: "bi-exclamation-triangle",
    severity: "warning"
  };
};

const formatReasonShort = (reason: string | null): string => {
  if (!reason) return "Tidak ada info";
  const parsed = parseRunReason(reason);
  return parsed.title;
};

type ParsedSendError = {
  label: string;
  explanation: string;
};

const parseSendLogError = (errorCode: string | null, errorMessage: string | null): ParsedSendError | null => {
  if (!errorCode && !errorMessage) return null;

  const code = (errorCode ?? "").toUpperCase();
  const msg = errorMessage ?? "";

  if (code === "GROUP_IDENTIFIER_MISSING") {
    return {
      label: "Group Tidak Dikenali",
      explanation: "Group ini tidak punya username atau Telegram ID. Sistem tidak bisa mengirim pesan ke group tanpa identifier."
    };
  }

  if (code === "FLOOD_WAIT") {
    const match = msg.match(/FLOOD_WAIT_(\d+)/i);
    const seconds = match ? match[1] : "?";
    return {
      label: `Rate Limit (${seconds} detik)`,
      explanation: `Telegram membatasi pengiriman dari akun ini. Harus menunggu ${seconds} detik sebelum bisa kirim lagi.`
    };
  }

  if (code === "PEER_FLOOD") {
    return {
      label: "Deteksi Spam oleh Telegram",
      explanation: "Akun ini terdeteksi mengirim terlalu banyak pesan. Telegram memblokir sementara. Tunggu beberapa jam sebelum mencoba lagi."
    };
  }

  if (code === "FORWARD_MESSAGE_NOT_FOUND") {
    return {
      label: "Pesan Forward Tidak Ditemukan",
      explanation: "Pesan yang ingin di-forward tidak ditemukan di channel/group sumber. Pastikan link sumber dan ID pesan masih valid."
    };
  }

  if (code === "TELEGRAM_SEND_ERROR") {
    const lower = msg.toLowerCase();

    // ── Izin kirim dibatasi (forbidden) ──
    if (lower.includes("chat_send_photos_forbidden")) {
      return {
        label: "Dilarang Kirim Foto",
        explanation: "Group ini melarang pengiriman foto/gambar. Admin group membatasi jenis konten yang boleh dikirim. Coba kirim sebagai teks saja atau minta admin mengizinkan foto."
      };
    }

    if (lower.includes("chat_send_media_forbidden")) {
      return {
        label: "Dilarang Kirim Media",
        explanation: "Group ini melarang pengiriman media (foto, video, dokumen). Admin group membatasi jenis konten. Coba kirim sebagai teks saja."
      };
    }

    if (lower.includes("chat_send_videos_forbidden")) {
      return {
        label: "Dilarang Kirim Video",
        explanation: "Group ini melarang pengiriman video. Admin group membatasi jenis konten yang boleh dikirim."
      };
    }

    if (lower.includes("chat_send_stickers_forbidden")) {
      return {
        label: "Dilarang Kirim Sticker",
        explanation: "Group ini melarang pengiriman sticker. Admin group membatasi jenis konten yang boleh dikirim."
      };
    }

    if (lower.includes("chat_send_gifs_forbidden")) {
      return {
        label: "Dilarang Kirim GIF",
        explanation: "Group ini melarang pengiriman GIF. Admin group membatasi jenis konten yang boleh dikirim."
      };
    }

    if (lower.includes("chat_send_docs_forbidden") || lower.includes("chat_send_document")) {
      return {
        label: "Dilarang Kirim Dokumen",
        explanation: "Group ini melarang pengiriman dokumen/file. Admin group membatasi jenis konten yang boleh dikirim."
      };
    }

    if (lower.includes("chat_send_plain_forbidden")) {
      return {
        label: "Dilarang Kirim Teks",
        explanation: "Group ini melarang pengiriman pesan teks biasa. Admin group membatasi siapa yang boleh mengirim pesan."
      };
    }

    if (lower.includes("chat_forwards_restricted") || lower.includes("forward_restricted")) {
      return {
        label: "Forward Dilarang",
        explanation: "Group atau channel sumber melarang forward pesan. Konten dilindungi dari penyalinan. Coba gunakan mode Direct Message."
      };
    }

    if (lower.includes("chat_write_forbidden") || lower.includes("write_forbidden")) {
      return {
        label: "Tidak Bisa Kirim ke Group",
        explanation: "Akun tidak memiliki izin untuk mengirim pesan di group ini. Kemungkinan akun bukan member atau group membatasi siapa yang boleh kirim."
      };
    }

    if (lower.includes("chat_restricted") || lower.includes("user_restricted")) {
      return {
        label: "Akun Dibatasi",
        explanation: "Akun Telegram ini sedang dibatasi (restricted) oleh Telegram atau oleh admin group. Tunggu beberapa saat atau hubungi admin."
      };
    }

    // ── Akses & keanggotaan ──
    if (lower.includes("user_banned") || lower.includes("banned_rights")) {
      return {
        label: "Akun Dibanned dari Group",
        explanation: "Akun Telegram ini sudah di-ban dari group tersebut sehingga tidak bisa mengirim pesan."
      };
    }

    if (lower.includes("user_not_participant") || lower.includes("not_participant")) {
      return {
        label: "Bukan Member Group",
        explanation: "Akun belum bergabung ke group ini. Akun harus join group terlebih dahulu sebelum bisa mengirim pesan."
      };
    }

    if (lower.includes("channel_private") || lower.includes("chat_forbidden")) {
      return {
        label: "Group Private / Tidak Bisa Diakses",
        explanation: "Group ini bersifat private dan akun tidak memiliki akses. Pastikan akun sudah join ke group terlebih dahulu."
      };
    }

    if (lower.includes("channel_invalid") || lower.includes("chat_id_invalid") || lower.includes("peer_id_invalid")) {
      return {
        label: "ID Group Tidak Valid",
        explanation: "ID atau referensi group tidak valid. Kemungkinan group sudah dihapus atau ID-nya salah."
      };
    }

    // ── Pesan & konten ──
    if (lower.includes("msg_id_invalid") || lower.includes("message_id_invalid")) {
      return {
        label: "ID Pesan Tidak Valid",
        explanation: "Pesan yang direferensikan tidak valid atau sudah dihapus dari sumber."
      };
    }

    if (lower.includes("message_too_long")) {
      return {
        label: "Pesan Terlalu Panjang",
        explanation: "Isi pesan melebihi batas karakter yang diizinkan Telegram. Coba persingkat teks pesan."
      };
    }

    if (lower.includes("message_empty")) {
      return {
        label: "Pesan Kosong",
        explanation: "Pesan yang dikirim kosong. Pastikan ada teks atau media yang diisi."
      };
    }

    if (lower.includes("media_invalid") || lower.includes("media_empty")) {
      return {
        label: "Media Tidak Valid",
        explanation: "File media yang dilampirkan tidak valid, rusak, atau tidak didukung oleh Telegram."
      };
    }

    if (lower.includes("photo_invalid") || lower.includes("photo_save_file")) {
      return {
        label: "Foto Tidak Valid",
        explanation: "File foto tidak valid atau gagal diproses. Pastikan format gambar didukung (JPG, PNG) dan ukurannya tidak terlalu besar."
      };
    }

    // ── Koneksi & jaringan ──
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return {
        label: "Koneksi Timeout",
        explanation: "Koneksi ke server Telegram timeout. Ini biasanya masalah jaringan sementara. Broadcast akan otomatis coba lagi di siklus berikutnya."
      };
    }

    if (lower.includes("connection") || lower.includes("network") || lower.includes("econnreset") || lower.includes("enotfound")) {
      return {
        label: "Gangguan Koneksi",
        explanation: "Terjadi gangguan koneksi jaringan ke server Telegram. Periksa koneksi internet server."
      };
    }

    // ── Username & resolusi ──
    if (lower.includes("username_not_occupied") || lower.includes("username_invalid")) {
      return {
        label: "Username Group Tidak Valid",
        explanation: "Username group tidak ditemukan atau sudah berubah. Periksa kembali username group di Telegram."
      };
    }

    if (lower.includes("invite_hash_expired") || lower.includes("invite_hash_invalid")) {
      return {
        label: "Link Invite Tidak Valid",
        explanation: "Link invite group sudah kadaluarsa atau tidak valid. Minta link invite baru dari admin group."
      };
    }

    // ── Rate limit & slowmode ──
    if (lower.includes("slowmode_wait") || lower.includes("slow_mode")) {
      const waitMatch = msg.match(/(\d+)/);
      const waitSec = waitMatch ? waitMatch[1] : "?";
      return {
        label: `Slowmode Aktif (${waitSec}s)`,
        explanation: `Group ini mengaktifkan slowmode. Harus menunggu ${waitSec} detik antar pesan. Tingkatkan delay antar pesan di Broadcast Setting.`
      };
    }

    // ── Akun ──
    if (lower.includes("auth_key") || lower.includes("session_expired") || lower.includes("session_revoked")) {
      return {
        label: "Sesi Telegram Expired",
        explanation: "Sesi login Telegram sudah kadaluarsa atau dicabut. Lakukan login ulang di menu Session Telegram."
      };
    }

    if (lower.includes("user_deactivated")) {
      return {
        label: "Akun Telegram Dinonaktifkan",
        explanation: "Akun Telegram yang digunakan sudah dinonaktifkan atau dihapus. Gunakan akun lain untuk broadcast."
      };
    }

    // ── Fallback: coba ekstrak info dari format "403: ERROR_NAME (caused by ...)" ──
    const codeMatch = msg.match(/^(\d{3}):\s*(\S+)/);
    if (codeMatch) {
      const httpCode = codeMatch[1];
      const errName = codeMatch[2].replace(/[()]/g, "");
      const readableName = errName.replace(/_/g, " ").toLowerCase();

      const httpLabels: Record<string, string> = {
        "400": "Permintaan Tidak Valid",
        "401": "Tidak Terautentikasi",
        "403": "Akses Ditolak",
        "404": "Tidak Ditemukan",
        "406": "Tidak Bisa Diproses",
        "420": "Rate Limited",
        "500": "Server Error Telegram"
      };

      const httpLabel = httpLabels[httpCode] ?? `Error ${httpCode}`;

      return {
        label: `${httpLabel} — ${errName}`,
        explanation: `Telegram menolak permintaan dengan kode ${httpCode} (${readableName}). Ini berarti akun atau group memiliki pembatasan tertentu yang mencegah pengiriman pesan ini.`
      };
    }

    return {
      label: "Error Telegram",
      explanation: msg || "Terjadi error saat mengirim pesan melalui Telegram. Lihat detail teknis untuk informasi lebih lanjut."
    };
  }

  return {
    label: code || "Error",
    explanation: msg || "Terjadi kesalahan yang tidak dikenali."
  };
};

const ROWS_PER_PAGE_OPTIONS = [5, 10, 20, 50];

const parseRunMode = (markers: string[]): { mode: string; detail: string } => {
  const modeMarker = markers.find((m) => m.startsWith("__TBM_MODE:"));
  if (!modeMarker) return { mode: "-", detail: "-" };

  const modeVal = modeMarker.replace("__TBM_MODE:", "");

  if (modeVal === "DIRECT_TEXT") {
    const textMarker = markers.find((m) => m.startsWith("__TBM_TEXT:"));
    if (textMarker) {
      try {
        const decoded = atob(textMarker.replace("__TBM_TEXT:", ""));
        const preview = decoded.length > 60 ? decoded.slice(0, 60) + "..." : decoded;
        return { mode: "Direct", detail: preview };
      } catch {
        return { mode: "Direct", detail: "(teks)" };
      }
    }
    return { mode: "Direct", detail: "(teks)" };
  }

  if (modeVal === "FORWARD_LINK") {
    const srcMarker = markers.find((m) => m.startsWith("__TBM_FORWARD_SOURCE:"));
    const source = srcMarker ? srcMarker.replace("__TBM_FORWARD_SOURCE:", "") : "?";
    const msgMarker = markers.find((m) => m.startsWith("__TBM_FORWARD_MESSAGE_ID:"));
    const msgId = msgMarker ? msgMarker.replace("__TBM_FORWARD_MESSAGE_ID:", "") : null;
    const link = source.startsWith("-") || source.startsWith("@")
      ? source
      : `t.me/${source}${msgId ? `/${msgId}` : ""}`;
    return { mode: "Forward", detail: link };
  }

  return { mode: modeVal, detail: "-" };
};

const statusBadgeClass = (status: SendLogItem["status"]) => {
  if (status === "SUCCESS") {
    return "badge tbm-status-success";
  }

  if (status === "FAILED") {
    return "badge tbm-status-danger";
  }

  return "badge tbm-status-warning";
};

const runStatusBadgeClass = (status: RunItem["status"]) => {
  if (status === "COMPLETED") {
    return "badge tbm-status-success";
  }

  if (status === "FAILED") {
    return "badge tbm-status-danger";
  }

  if (status === "RUNNING") {
    return "badge tbm-status-info";
  }

  if (status === "PAUSED") {
    return "badge tbm-status-warning";
  }

  return "badge tbm-status-neutral";
};

const runStatusLabel = (run: RunItem): { label: string; sublabel: string; icon: string } => {
  const hasBatch = run.totalDurationHours && run.intervalMinutes;
  const maxCycles = hasBatch ? Math.floor((run.totalDurationHours! * 60) / run.intervalMinutes!) : null;

  if (run.status === "RUNNING") {
    // Check if it's waiting between cycles (reason contains "Waiting")
    const isWaiting = run.reason?.toLowerCase().includes("waiting") || run.reason?.toLowerCase().includes("menunggu");
    if (hasBatch && isWaiting) {
      return {
        label: "Menunggu Siklus",
        sublabel: `Siklus ${run.completedCycles}/${maxCycles} selesai, menunggu ${run.intervalMinutes}m`,
        icon: "bi-hourglass-split"
      };
    }

    return {
      label: "Sedang Berjalan",
      sublabel: hasBatch
        ? `Siklus ${run.completedCycles + 1}/${maxCycles} sedang mengirim ke ${run.pendingCount} group`
        : `Mengirim ke ${run.pendingCount} group tersisa`,
      icon: "bi-broadcast"
    };
  }

  if (run.status === "PAUSED") {
    const isFlood = run.reason?.toLowerCase().includes("floodwait");
    const isPeerFlood = run.reason?.toLowerCase().includes("peerflood");
    if (isFlood) {
      return {
        label: "Terkena Rate Limit",
        sublabel: "Auto-pause karena FloodWait, akan resume otomatis",
        icon: "bi-hourglass-split"
      };
    }
    if (isPeerFlood) {
      return {
        label: "Terdeteksi Spam",
        sublabel: "Auto-pause karena PeerFlood, perlu resume manual",
        icon: "bi-shield-exclamation"
      };
    }
    return {
      label: "Dijeda",
      sublabel: "Broadcast dijeda oleh user",
      icon: "bi-pause-circle"
    };
  }

  if (run.status === "PENDING") {
    return {
      label: "Menunggu Antrian",
      sublabel: "Broadcast akan segera diproses oleh worker",
      icon: "bi-clock"
    };
  }

  if (run.status === "COMPLETED") {
    return {
      label: "Selesai",
      sublabel: hasBatch
        ? `${run.completedCycles} siklus selesai`
        : `${run.sentCount} pesan terkirim`,
      icon: "bi-check-circle"
    };
  }

  if (run.status === "FAILED") {
    const isCancelled = run.reason?.toLowerCase().includes("dihentikan");
    return {
      label: isCancelled ? "Dihentikan" : "Gagal",
      sublabel: isCancelled ? "Dihentikan oleh user" : (run.reason ?? "Error tidak diketahui"),
      icon: isCancelled ? "bi-stop-circle" : "bi-x-circle"
    };
  }

  return { label: run.status, sublabel: "", icon: "bi-question-circle" };
};

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <div className="tbm-form-help">{children}</div>;
}

function TableEmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="tbm-table-empty">{message}</td>
    </tr>
  );
}

export default function DashboardPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeSection, setActiveSection] = useState<DashboardSectionId>("overview");
  const [logFilter, setLogFilter] = useState<"ALL" | "FAILED" | "SUCCESS">("ALL");
  const [logRunFilter, setLogRunFilter] = useState<string>("ALL");
  const [logDateFrom, setLogDateFrom] = useState("");
  const [logDateTo, setLogDateTo] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupPage, setGroupPage] = useState(0);
  const [groupPerPage, setGroupPerPage] = useState(10);
  const [runHistoryPage, setRunHistoryPage] = useState(0);
  const [runHistoryPerPage, setRunHistoryPerPage] = useState(5);
  const [sendLogPage, setSendLogPage] = useState(0);
  const [sendLogPerPage, setSendLogPerPage] = useState(10);
  const [topbarSearch, setTopbarSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(10);
  const [refreshCountdown, setRefreshCountdown] = useState(10);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [accounts, setAccounts] = useState<TelegramAccount[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [sendLogs, setSendLogs] = useState<SendLogItem[]>([]);
  const [busyAccounts, setBusyAccounts] = useState<BusyAccountInfo[]>([]);

  const [groupAddInput, setGroupAddInput] = useState("");
  const [groupAddAccountId, setGroupAddAccountId] = useState("");

  const [templateForm, setTemplateForm] = useState({
    name: "",
    text: "",
    mediaUrl: "",
    spinEnabled: false,
    isActive: true
  });

  const [settingForm, setSettingForm] = useState(defaultSettingForm);
  const [scheduleForm, setScheduleForm] = useState({
    name: "",
    type: "INTERVAL" as "MANUAL" | "INTERVAL" | "CRON",
    intervalHours: "6",
    cronExpr: "",
    settingId: ""
  });
  const [runForm, setRunForm] = useState({
    label: "",
    settingId: "",
    accountId: "",
    mode: "DIRECT_TEXT" as "DIRECT_TEXT" | "FORWARD_LINK",
    messageText: "",
    messageLink: "",
    totalDurationHours: "",
    intervalMinutes: ""
  });
  const [telegramOtpForm, setTelegramOtpForm] = useState({ phone: "", label: "" });
  const [telegramVerifyForm, setTelegramVerifyForm] = useState({ phone: "", code: "" });

  const activeSettingId = useMemo(() => {
    return settings.find((item) => item.isActive)?.id ?? "";
  }, [settings]);

  const selectedSectionMeta = useMemo(() => {
    return sectionMeta.find((item) => item.id === activeSection) ?? sectionMeta[0];
  }, [activeSection]);

  const filteredSectionGroups = useMemo(() => {
    const keyword = topbarSearch.trim().toLowerCase();
    if (!keyword) {
      return sectionGroups;
    }

    return sectionGroups
      .map((group) => {
        const items = group.items.filter((itemId) => {
          const item = sectionMeta.find((metaItem) => metaItem.id === itemId);
          if (!item) {
            return false;
          }

          return item.label.toLowerCase().includes(keyword) || item.subtitle.toLowerCase().includes(keyword);
        });

        return {
          ...group,
          items
        };
      })
      .filter((group) => group.items.length > 0);
  }, [topbarSearch]);

  const connectedAccounts = useMemo(() => {
    return accounts.filter((item) => item.status === "CONNECTED");
  }, [accounts]);

  const activeGroupsCount = useMemo(() => {
    return groups.filter((item) => item.isActive).length;
  }, [groups]);

  const runBlockers = useMemo(() => {
    const blockers: string[] = [];

    if (!connectedAccounts.length) {
      blockers.push("Belum ada account Telegram berstatus CONNECTED.");
    }

    if (!activeGroupsCount) {
      blockers.push("Belum ada group aktif sebagai target broadcast.");
    }

    if (runForm.mode === "DIRECT_TEXT" && !runForm.messageText.trim()) {
      blockers.push("Isi pesan teks untuk mode Direct Message.");
    }

    if (runForm.mode === "FORWARD_LINK" && !runForm.messageLink.trim()) {
      blockers.push("Isi link Telegram untuk mode Forward from Link.");
    }

    return blockers;
  }, [connectedAccounts.length, activeGroupsCount, runForm.mode, runForm.messageText, runForm.messageLink]);

  const latestFailedRun = useMemo(() => {
    return [...runs]
      .filter((item) => item.status === "FAILED")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
  }, [runs]);

  /** Unique run IDs from send logs for the session filter dropdown */
  const logRunOptions = useMemo(() => {
    const runMap = new Map<string, { id: string; label: string; status: string; accountLabel: string }>();
    for (const log of sendLogs) {
      if (runMap.has(log.runId)) continue;
      const accLabel = log.account ? `${log.account.label} (${log.account.phone})` : "Auto";
      runMap.set(log.runId, {
        id: log.runId,
        label: log.run?.label || log.runId.slice(0, 8),
        status: log.run?.status ?? "?",
        accountLabel: accLabel
      });
    }
    return Array.from(runMap.values());
  }, [sendLogs]);

  const filteredLogs = useMemo(() => {
    let result = sendLogs;

    if (logRunFilter !== "ALL") {
      result = result.filter((item) => item.runId === logRunFilter);
    }

    if (logFilter !== "ALL") {
      result = result.filter((item) => item.status === logFilter);
    }

    if (logDateFrom) {
      const from = new Date(logDateFrom);
      from.setHours(0, 0, 0, 0);
      result = result.filter((item) => new Date(item.timestamp) >= from);
    }

    if (logDateTo) {
      const to = new Date(logDateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter((item) => new Date(item.timestamp) <= to);
    }

    return result;
  }, [sendLogs, logRunFilter, logFilter, logDateFrom, logDateTo]);

  // Filtered groups by search
  const filteredGroups = useMemo(() => {
    const keyword = groupSearch.trim().toLowerCase();
    if (!keyword) return groups;
    return groups.filter((g) => {
      const username = (g.username ?? "").toLowerCase();
      const telegramId = (g.telegramId ?? "").toLowerCase();
      const title = (g.title ?? "").toLowerCase();
      return username.includes(keyword) || telegramId.includes(keyword) || title.includes(keyword);
    });
  }, [groups, groupSearch]);

  // Reset pagination when data or filter changes
  useEffect(() => { setGroupPage(0); }, [filteredGroups.length, groupSearch]);
  useEffect(() => { setRunHistoryPage(0); }, [runs.length]);
  useEffect(() => { setSendLogPage(0); }, [filteredLogs.length, logRunFilter, logFilter, logDateFrom, logDateTo]);

  // Paginated slices
  const groupTotalPages = Math.max(1, Math.ceil(filteredGroups.length / groupPerPage));
  const paginatedGroups = filteredGroups.slice(groupPage * groupPerPage, (groupPage + 1) * groupPerPage);

  const runHistoryTotalPages = Math.max(1, Math.ceil(runs.length / runHistoryPerPage));
  const paginatedRuns = runs.slice(runHistoryPage * runHistoryPerPage, (runHistoryPage + 1) * runHistoryPerPage);

  const sendLogTotalPages = Math.max(1, Math.ceil(filteredLogs.length / sendLogPerPage));
  const paginatedLogs = filteredLogs.slice(sendLogPage * sendLogPerPage, (sendLogPage + 1) * sendLogPerPage);

  const notificationCount = (latestFailedRun ? 1 : 0) + runBlockers.length + (error ? 1 : 0);

  const weeklyRunTrend = useMemo(() => {
    const now = Date.now();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;

    let currentSent = 0;
    let previousSent = 0;
    let currentFailed = 0;
    let previousFailed = 0;

    runs.forEach((run) => {
      const timestamp = new Date(run.createdAt).getTime();
      if (Number.isNaN(timestamp)) {
        return;
      }

      if (timestamp >= now - oneWeek) {
        currentSent += run.sentCount;
        currentFailed += run.failedCount;
      } else if (timestamp >= now - (2 * oneWeek)) {
        previousSent += run.sentCount;
        previousFailed += run.failedCount;
      }
    });

    return {
      sentDelta: calculateDeltaPercent(currentSent, previousSent),
      failedDelta: calculateDeltaPercent(currentFailed, previousFailed)
    };
  }, [runs]);

  const overviewKpis = useMemo<OverviewKpiCard[]>(() => {
    const totalSent = overview?.stats.totalSent ?? 0;
    const totalFailed = overview?.stats.failed ?? 0;
    const totalPending = overview?.stats.pending ?? 0;
    const sentVsFailedTotal = totalSent + totalFailed;

    const successRate = sentVsFailedTotal ? (totalSent / sentVsFailedTotal) * 100 : 0;
    const activeGroupRate = groups.length ? (activeGroupsCount / groups.length) * 100 : 0;
    const connectedRate = accounts.length
      ? (connectedAccounts.length / accounts.length) * 100
      : connectedAccounts.length
        ? 100
        : 0;

    return [
      {
        id: "sent",
        icon: "bi-eye",
        label: "Total Sent",
        value: formatCompactNumber(totalSent),
        helper: `Success rate ${percentNumberFormatter.format(successRate)}%`,
        trend: weeklyRunTrend.sentDelta
      },
      {
        id: "failed",
        icon: "bi-exclamation-triangle",
        label: "Failed",
        value: formatCompactNumber(totalFailed),
        helper: `Pending ${formatCompactNumber(totalPending)}`,
        trend: weeklyRunTrend.failedDelta,
        inverse: true
      },
      {
        id: "groups",
        icon: "bi-collection",
        label: "Active Groups",
        value: formatCompactNumber(activeGroupsCount),
        helper: `Coverage ${percentNumberFormatter.format(activeGroupRate)}%`,
        trend: activeGroupRate
      },
      {
        id: "accounts",
        icon: "bi-people",
        label: "Connected Account",
        value: formatCompactNumber(connectedAccounts.length),
        helper: `Connected rate ${percentNumberFormatter.format(connectedRate)}%`,
        trend: connectedRate
      }
    ];
  }, [
    overview?.stats.totalSent,
    overview?.stats.failed,
    overview?.stats.pending,
    groups.length,
    activeGroupsCount,
    accounts.length,
    connectedAccounts.length,
    weeklyRunTrend.sentDelta,
    weeklyRunTrend.failedDelta
  ]);

  const monthlySeries = useMemo<MonthlySeriesPoint[]>(() => {
    const series = monthLabels.map((label) => ({
      label,
      sent: 0,
      failed: 0
    }));

    runs.forEach((run) => {
      const timestamp = new Date(run.createdAt).getTime();
      if (Number.isNaN(timestamp)) {
        return;
      }

      const monthIndex = new Date(timestamp).getMonth();
      series[monthIndex].sent += run.sentCount;
      series[monthIndex].failed += run.failedCount;
    });

    return series;
  }, [runs, overview?.stats.totalSent, overview?.stats.failed]);

  const monthlyChart = useMemo(() => {
    const width = 920;
    const height = 318;
    const paddingX = 30;
    const paddingY = 24;
    const plotWidth = width - (paddingX * 2);
    const plotHeight = height - (paddingY * 2);
    const maxValue = Math.max(...monthlySeries.map((item) => Math.max(item.sent, item.failed)), 10);

    const xForIndex = (index: number) => {
      if (monthlySeries.length <= 1) {
        return width / 2;
      }

      return paddingX + (index / (monthlySeries.length - 1)) * plotWidth;
    };

    const yForValue = (value: number) => {
      return height - paddingY - (value / maxValue) * plotHeight;
    };

    const sentPoints = monthlySeries
      .map((item, index) => `${xForIndex(index).toFixed(2)},${yForValue(item.sent).toFixed(2)}`)
      .join(" ");

    const failedPoints = monthlySeries
      .map((item, index) => `${xForIndex(index).toFixed(2)},${yForValue(item.failed).toFixed(2)}`)
      .join(" ");

    const sentArea = `${paddingX},${height - paddingY} ${sentPoints} ${xForIndex(monthlySeries.length - 1).toFixed(2)},${(height - paddingY).toFixed(2)}`;

    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const value = (maxValue / 4) * index;
      return {
        value: Math.round(value),
        y: yForValue(value)
      };
    });

    const ticks = monthlySeries.map((item, index) => {
      return {
        label: item.label,
        x: xForIndex(index)
      };
    });

    return {
      width,
      height,
      paddingX,
      sentPoints,
      failedPoints,
      sentArea,
      gridLines,
      ticks
    };
  }, [monthlySeries]);

  const weeklySeries = useMemo<WeeklySeriesPoint[]>(() => {
    const series = weekdayLabels.map((label) => ({
      label,
      sent: 0,
      failed: 0
    }));

    sendLogs.forEach((log) => {
      const timestamp = new Date(log.timestamp).getTime();
      if (Number.isNaN(timestamp)) {
        return;
      }

      const weekdayIndex = (new Date(timestamp).getDay() + 6) % 7;

      if (log.status === "SUCCESS") {
        series[weekdayIndex].sent += 1;
      }

      if (log.status === "FAILED") {
        series[weekdayIndex].failed += 1;
      }
    });

    return series;
  }, [sendLogs, overview?.stats.totalSent, overview?.stats.failed]);

  const weeklyBarMax = useMemo(() => {
    return Math.max(...weeklySeries.map((item) => item.sent + item.failed), 6);
  }, [weeklySeries]);

  const withAction = async (action: () => Promise<void>) => {
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan");
    }
  };

  const withBusyAction = async (key: string, action: () => Promise<void>) => {
    setBusyActions((prev) => ({ ...prev, [key]: true }));

    try {
      await withAction(action);
    } finally {
      setBusyActions((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const isBusy = (key: string) => {
    return Boolean(busyActions[key]);
  };

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) {
      setSyncing(true);
      setError("");
    }

    try {
      const [
        overviewRes,
        groupsRes,
        settingsRes,
        schedulesRes,
        accountsRes,
        templatesRes,
        runsRes,
        sendLogsRes,
        busyAccountsRes
      ] = await Promise.all([
        apiFetch<DashboardOverview>("/api/dashboard/overview"),
        apiFetch<GroupItem[]>("/api/groups"),
        apiFetch<SettingItem[]>("/api/settings"),
        apiFetch<ScheduleItem[]>("/api/scheduler"),
        apiFetch<TelegramAccount[]>("/api/telegram/accounts"),
        apiFetch<TemplateItem[]>("/api/templates"),
        apiFetch<RunItem[]>("/api/broadcast/runs"),
        apiFetch<SendLogItem[]>("/api/logs/send"),
        apiFetch<BusyAccountInfo[]>("/api/broadcast/busy-accounts")
      ]);

      setOverview(overviewRes);
      setGroups(groupsRes);
      setSettings(settingsRes);
      setSchedules(schedulesRes);
      setAccounts(accountsRes);
      setTemplates(templatesRes);
      setRuns(runsRes);
      setSendLogs(sendLogsRes.slice(0, 120));
      setBusyAccounts(busyAccountsRes);
      setLastRefreshedAt(new Date());
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "Gagal load dashboard");
      }
    } finally {
      if (!silent) {
        setSyncing(false);
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }

    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedMode = window.localStorage.getItem("tbm-dark-mode");
    if (!storedMode) {
      return;
    }

    try {
      setDarkMode(JSON.parse(storedMode) === true);
    } catch {
      setDarkMode(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.classList.toggle("dark", darkMode);
    window.localStorage.setItem("tbm-dark-mode", JSON.stringify(darkMode));
  }, [darkMode]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [activeSection]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    setRefreshCountdown(autoRefreshInterval);

    countdownRef.current = setInterval(() => {
      setRefreshCountdown((prev) => {
        if (prev <= 1) {
          return autoRefreshInterval;
        }
        return prev - 1;
      });
    }, 1000);

    autoRefreshRef.current = setInterval(() => {
      void loadAll(true);
      setRefreshCountdown(autoRefreshInterval);
    }, autoRefreshInterval * 1000);

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [autoRefresh, autoRefreshInterval, loadAll]);

  useEffect(() => {
    if (activeSettingId && !runForm.settingId) {
      setRunForm((prev) => ({ ...prev, settingId: activeSettingId }));
    }
    if (activeSettingId && !scheduleForm.settingId) {
      setScheduleForm((prev) => ({ ...prev, settingId: activeSettingId }));
    }
  }, [activeSettingId, runForm.settingId, scheduleForm.settingId]);

  useEffect(() => {
    const activeSetting = settings.find((item) => item.isActive) ?? settings[0];
    if (!activeSetting) {
      return;
    }

    setSettingForm(mapSettingToForm(activeSetting));
  }, [settings]);

  const handleAddGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("group-add", async () => {
      const input = groupAddInput.trim();
      if (!input) {
        throw new Error("Masukkan link group, username, atau link addlist");
      }

      const result = await apiFetch<{
        type: "username" | "private_invite" | "addlist";
        joined: boolean;
        created: number;
        updated: number;
        skipped: number;
        total: number;
      }>("/api/groups/add-by-link", {
        method: "POST",
        body: JSON.stringify({
          input,
          accountId: groupAddAccountId || undefined
        })
      });

      const typeLabels: Record<string, string> = {
        username: "Group publik",
        private_invite: "Group private",
        addlist: "Folder addlist"
      };

      const typeLabel = typeLabels[result.type] ?? result.type;
      const parts: string[] = [];
      if (result.created) parts.push(`${result.created} baru ditambahkan`);
      if (result.updated) parts.push(`${result.updated} diperbarui`);
      if (result.joined) parts.push("akun otomatis join");

      setNotice(`${typeLabel}: ${parts.join(", ")}${result.total > 1 ? ` (${result.total} group)` : ""}`);
      setGroupAddInput("");
      await loadAll();
    });
  };

  const handleToggleGroup = async (id: string, isActive: boolean) => {
    await withBusyAction(`group-toggle-${id}`, async () => {
      await apiFetch(`/api/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !isActive })
      });

      await loadAll();
    });
  };

  const handleSaveSetting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("setting-save", async () => {
      await apiFetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          name: settingForm.name,
          isActive: settingForm.isActive,
          batchSizeMin: 1,
          batchSizeMax: 1,
          messageDelayMinSec: settingForm.messageDelaySec,
          messageDelayMaxSec: settingForm.messageDelaySec,
          batchDelayMinMin: 0,
          batchDelayMaxMin: 0,
          sendMode: "NEW_MESSAGE",
          randomizeGroups: settingForm.randomizeGroups,
          autoPauseOnLimit: settingForm.autoPauseOnLimit
        })
      });

      setNotice("Broadcast setting tersimpan");
      await loadAll();
    });
  };

  const handleCreateSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("schedule-create", async () => {
      if (!scheduleForm.name.trim()) {
        throw new Error("Nama schedule wajib diisi");
      }

      if (!scheduleForm.settingId) {
        throw new Error("Pilih setting untuk schedule");
      }

      if (scheduleForm.type === "CRON" && !scheduleForm.cronExpr.trim()) {
        throw new Error("Cron expression wajib diisi untuk schedule CRON");
      }

      await apiFetch("/api/scheduler", {
        method: "POST",
        body: JSON.stringify({
          name: scheduleForm.name.trim(),
          type: scheduleForm.type,
          intervalHours: scheduleForm.type === "INTERVAL" ? Number(scheduleForm.intervalHours) : undefined,
          cronExpr: scheduleForm.type === "CRON" ? scheduleForm.cronExpr.trim() : undefined,
          isActive: true,
          settingId: scheduleForm.settingId
        })
      });

      setNotice("Schedule dibuat");
      await loadAll();
    });
  };


  const handleSaveTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("template-save", async () => {
      if (!templateForm.name.trim()) {
        throw new Error("Nama template wajib diisi");
      }

      if (!templateForm.text.trim() && !templateForm.mediaUrl.trim()) {
        throw new Error("Isi teks template atau media URL");
      }

      await apiFetch("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          name: templateForm.name.trim(),
          text: templateForm.text.trim(),
          mediaUrl: templateForm.mediaUrl.trim() || null,
          spinEnabled: templateForm.spinEnabled,
          isActive: templateForm.isActive
        })
      });

      setTemplateForm({
        name: "",
        text: "",
        mediaUrl: "",
        spinEnabled: false,
        isActive: true
      });
      setNotice("Template berhasil disimpan");
      await loadAll();
    });
  };

  const handleToggleTemplate = async (id: string, isActive: boolean) => {
    await withBusyAction(`template-toggle-${id}`, async () => {
      await apiFetch(`/api/templates/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !isActive })
      });

      await loadAll();
    });
  };

  const handleDeleteTemplate = async (id: string) => {
    await withBusyAction(`template-delete-${id}`, async () => {
      await apiFetch(`/api/templates/${id}`, {
        method: "DELETE"
      });

      setNotice("Template dihapus");
      await loadAll();
    });
  };

  const handleUseTemplateForBroadcast = (template: TemplateItem) => {
    setRunForm((prev) => ({
      ...prev,
      mode: "DIRECT_TEXT",
      messageText: template.text
    }));
    setActiveSection("broadcast");
  };

  const handleRunBroadcast = async () => {
    await withBusyAction("broadcast-run", async () => {
      const durationVal = runForm.totalDurationHours ? Number(runForm.totalDurationHours) : undefined;
      const intervalVal = runForm.intervalMinutes ? Number(runForm.intervalMinutes) : undefined;

      if (durationVal && !intervalVal) {
        throw new Error("Jika durasi diisi, interval antar broadcast juga harus diisi.");
      }
      if (!durationVal && intervalVal) {
        throw new Error("Jika interval diisi, durasi total broadcast juga harus diisi.");
      }

      const basePayload = {
        label: runForm.label.trim() || undefined,
        settingId: runForm.settingId || undefined,
        accountId: runForm.accountId || undefined,
        totalDurationHours: durationVal,
        intervalMinutes: intervalVal
      };

      const payload = runForm.mode === "DIRECT_TEXT"
        ? {
            ...basePayload,
            mode: "DIRECT_TEXT" as const,
            messageText: runForm.messageText.trim()
          }
        : {
            ...basePayload,
            mode: "FORWARD_LINK" as const,
            messageLink: runForm.messageLink.trim()
          };

      await apiFetch("/api/broadcast/run", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      const intervalInfo = durationVal && intervalVal
        ? ` (${durationVal} jam, interval ${intervalVal} menit)`
        : "";
      setNotice(`Broadcast run masuk queue${intervalInfo}`);
      await loadAll();
      setActiveSection("monitoring");
    });
  };

  const handleRunAction = async (id: string, action: "pause" | "resume" | "cancel") => {
    if (action === "cancel") {
      const confirmed = window.confirm("Yakin ingin menghentikan broadcast ini? Broadcast yang sudah dihentikan tidak bisa dilanjutkan.");
      if (!confirmed) return;
    }

    await withBusyAction(`run-${action}-${id}`, async () => {
      await apiFetch(`/api/broadcast/runs/${id}/${action}`, {
        method: "POST"
      });

      await loadAll();
    });
  };

  const handleScheduleAction = async (id: string, action: "trigger" | "toggle", isActive?: boolean) => {
    await withBusyAction(`schedule-${action}-${id}`, async () => {
      if (action === "trigger") {
        await apiFetch(`/api/scheduler/${id}/trigger`, {
          method: "POST"
        });
      } else {
        await apiFetch(`/api/scheduler/${id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ isActive: !isActive })
        });
      }

      await loadAll();
    });
  };

  const handleRequestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("otp-request", async () => {
      await apiFetch("/api/telegram/request-otp", {
        method: "POST",
        body: JSON.stringify(telegramOtpForm)
      });

      setTelegramVerifyForm((prev) => ({ ...prev, phone: telegramOtpForm.phone.trim() }));
      setNotice("OTP terkirim. Lanjut ke verifikasi OTP.");
    });
  };

  const handleVerifyOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    await withBusyAction("otp-verify", async () => {
      await apiFetch("/api/telegram/verify-otp", {
        method: "POST",
        body: JSON.stringify(telegramVerifyForm)
      });

      setNotice("Akun Telegram terhubung");
      await loadAll();
    });
  };

  const handleExportLogs = async () => {
    await withBusyAction("logs-export", async () => {
      const token = getToken();
      const response = await fetch(`${apiBaseUrl}/api/logs/send/export`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error("Gagal export logs");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "send-logs.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    });
  };

  const handleLogout = () => {
    clearToken();
    router.push("/login");
  };

  const renderOverviewSection = () => {
    const activeScheduleCount = schedules.filter((item) => item.isActive).length;
    const healthChecks = [
      {
        id: "telegram",
        label: "Telegram Session",
        detail: `${connectedAccounts.length} akun connected`,
        ok: connectedAccounts.length > 0
      },
      {
        id: "groups",
        label: "Target Group",
        detail: `${activeGroupsCount} group aktif`,
        ok: activeGroupsCount > 0
      },
      {
        id: "broadcast-content",
        label: "Konten Siap Kirim",
        detail: runForm.mode === "FORWARD_LINK"
          ? runForm.messageLink.trim()
            ? "Link forward siap"
            : "Link forward belum diisi"
          : runForm.messageText.trim()
            ? "Pesan direct siap"
            : "Pesan direct belum diisi",
        ok: runForm.mode === "FORWARD_LINK" ? Boolean(runForm.messageLink.trim()) : Boolean(runForm.messageText.trim())
      },
      {
        id: "scheduler",
        label: "Scheduler",
        detail: `${activeScheduleCount} scheduler aktif`,
        ok: activeScheduleCount > 0
      }
    ];

    return (
      <>
        <div className="tbm-kpi-grid">
          {overviewKpis.map((card) => {
            const trendUp = card.trend >= 0;
            const trendClass = card.inverse
              ? trendUp
                ? "tbm-trend-negative"
                : "tbm-trend-positive"
              : trendUp
                ? "tbm-trend-positive"
                : "tbm-trend-negative";

            return (
              <article className="tbm-dashboard-kpi" key={card.id}>
                <span className="tbm-dashboard-kpi-icon">
                  <i className={`bi ${card.icon}`}></i>
                </span>
                <div className="tbm-dashboard-kpi-content">
                  <div className="tbm-dashboard-kpi-label">{card.label}</div>
                  <div className="tbm-dashboard-kpi-value">{card.value}</div>
                  <div className={`tbm-dashboard-kpi-trend ${trendClass}`}>
                    <i className={`bi ${trendUp ? "bi-arrow-up-right" : "bi-arrow-down-right"}`}></i>
                    {formatTrend(card.trend)}
                  </div>
                </div>
                <div className="tbm-dashboard-kpi-helper">{card.helper}</div>
              </article>
            );
          })}
        </div>

        <div className="tbm-analytics-grid">
          <div className="tbm-panel tbm-chart-panel">
            <div className="tbm-chart-head">
              <div>
                <h5 className="tbm-panel-title mb-0">Broadcast Trend</h5>
                <p className="tbm-panel-desc mb-0">Performa sent dan failed per bulan.</p>
              </div>
              <div className="tbm-chart-legend">
                <span>
                  <i className="bi bi-circle-fill tbm-dot-sent"></i>
                  Total Sent
                </span>
                <span>
                  <i className="bi bi-circle-fill tbm-dot-failed"></i>
                  Failed
                </span>
              </div>
            </div>

            <div className="tbm-line-chart-wrap">
              <svg viewBox={`0 0 ${monthlyChart.width} ${monthlyChart.height}`} role="img" aria-label="Grafik trend broadcast bulanan">
                {monthlyChart.gridLines.map((line) => (
                  <g key={line.value}>
                    <line
                      x1={monthlyChart.paddingX}
                      y1={line.y}
                      x2={monthlyChart.width - monthlyChart.paddingX}
                      y2={line.y}
                      className="tbm-chart-grid-line"
                    />
                    <text x={8} y={line.y + 4} className="tbm-chart-grid-label">{line.value}</text>
                  </g>
                ))}

                <polygon points={monthlyChart.sentArea} className="tbm-chart-area" />
                <polyline points={monthlyChart.sentPoints} className="tbm-chart-line tbm-chart-line-sent" />
                <polyline points={monthlyChart.failedPoints} className="tbm-chart-line tbm-chart-line-failed" />
              </svg>
            </div>

            <div className="tbm-chart-month-row">
              {monthlyChart.ticks.map((tick) => (
                <span key={tick.label} style={{ left: `${(tick.x / monthlyChart.width) * 100}%` }}>{tick.label}</span>
              ))}
            </div>
          </div>

          <div className="tbm-panel tbm-weekly-panel">
            <div className="tbm-weekly-head">
              <h5 className="tbm-panel-title mb-0">Weekly Delivery</h5>
              <span className="tbm-period-pill">This Week</span>
            </div>
            <p className="tbm-panel-desc mb-0">Performa pengiriman sukses dan gagal per hari.</p>

            <div className="tbm-weekly-bars">
              {weeklySeries.map((item, index) => {
                const sentHeight = item.sent === 0 ? "0%" : `${Math.max(8, (item.sent / weeklyBarMax) * 100)}%`;
                const failedHeight = item.failed === 0 ? "0%" : `${Math.max(8, (item.failed / weeklyBarMax) * 100)}%`;

                return (
                  <div className="tbm-weekly-bar-col" key={`${item.label}-${index}`}>
                    <div className="tbm-weekly-bar-wrap">
                      <span className="tbm-weekly-bar tbm-weekly-bar-sent" style={{ height: sentHeight }}></span>
                      <span className="tbm-weekly-bar tbm-weekly-bar-failed" style={{ height: failedHeight }}></span>
                    </div>
                    <span className="tbm-weekly-label">{item.label}</span>
                  </div>
                );
              })}
            </div>

            <div className="tbm-weekly-legend">
              <span>
                <i className="bi bi-circle-fill tbm-dot-sent"></i>
                Success
              </span>
              <span>
                <i className="bi bi-circle-fill tbm-dot-failed"></i>
                Failed
              </span>
            </div>
          </div>
        </div>

        <div className="tbm-insight-grid">
          <div className="tbm-panel">
            <h5 className="tbm-panel-title">Flow Operasional (Urutan Kerja)</h5>
            <p className="tbm-panel-desc">Ikuti urutan ini supaya operasional tetap rapi dan minim error.</p>

            <div className="tbm-flow-grid mt-2">
              {[{
                id: "session",
                title: "Session Telegram",
                text: "Request OTP lalu verify OTP sampai status CONNECTED."
              }, {
                id: "groups",
                title: "Kelola Group",
                text: "Tambah group, import text/file, atau import link addlist."
              }, {
                id: "broadcast",
                title: "Mulai Broadcast",
                text: "Pilih mode Direct atau Forward Link, isi payload, lalu jalankan manual run."
              }].map((item, index) => (
                <div className="tbm-flow-card" key={item.id}>
                  <span className="tbm-flow-index">{index + 1}</span>
                  <h6>{item.title}</h6>
                  <p>{item.text}</p>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-primary mt-2"
                    onClick={() => setActiveSection(item.id as DashboardSectionId)}
                  >
                    Buka Modul
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="tbm-panel">
            <h5 className="tbm-panel-title">System Health</h5>
            <p className="tbm-panel-desc">Checklist kesiapan sebelum memulai broadcast.</p>

            <div className="tbm-health-list mt-2">
              {healthChecks.map((item) => (
                <div className="tbm-health-item" key={item.id}>
                  <span className={`tbm-health-indicator ${item.ok ? "ok" : "bad"}`}></span>
                  <div>
                    <div className="tbm-health-label">{item.label}</div>
                    <div className="tbm-health-detail">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            {latestFailedRun ? (() => {
              const parsed = parseRunReason(latestFailedRun.reason);
              return (
                <div className="alert alert-danger mb-0 mt-3">
                  <div className="d-flex align-items-center gap-2">
                    <i className={`bi ${parsed.icon}`} style={{ fontSize: "1.1rem" }}></i>
                    <div className="fw-semibold">{parsed.title}</div>
                  </div>
                  <div className="small mt-1">{parsed.description}</div>
                  <div className="small mt-1" style={{ opacity: 0.85 }}>
                    <i className="bi bi-lightbulb me-1"></i>{parsed.suggestion}
                  </div>
                  <button type="button" className="btn btn-sm btn-outline-danger mt-2" onClick={() => setActiveSection("monitoring")}>
                    Lihat Detail di Monitoring
                  </button>
                </div>
              );
            })() : (
              <div className="alert alert-success mb-0 mt-3">Tidak ada error kritis. Sistem siap untuk broadcast berikutnya.</div>
            )}
          </div>
        </div>
      </>
    );
  };

  const renderSessionSection = () => {
    return (
      <div className="tbm-panel">
        <h5 className="tbm-panel-title">Session Telegram</h5>
        <p className="tbm-panel-desc">Step ini wajib sebelum broadcast: akun harus CONNECTED.</p>

        <div className="d-grid mt-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          <form className="tbm-subpanel" onSubmit={(event) => void handleRequestOtp(event)}>
            <h6 className="tbm-subpanel-title">1) Request OTP</h6>
            <div className="mb-2">
              <label className="form-label">Phone</label>
              <input
                className="form-control"
                placeholder="+628123456789"
                value={telegramOtpForm.phone}
                onChange={(e) => setTelegramOtpForm((prev) => ({ ...prev, phone: e.target.value }))}
              />
              <FieldHelp>Format internasional, contoh +62...</FieldHelp>
            </div>
            <div className="mb-2">
              <label className="form-label">Label Account</label>
              <input
                className="form-control"
                placeholder="Akun Utama"
                value={telegramOtpForm.label}
                onChange={(e) => setTelegramOtpForm((prev) => ({ ...prev, label: e.target.value }))}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={isBusy("otp-request") || syncing}>
              {isBusy("otp-request") ? "Mengirim OTP..." : "Kirim OTP"}
            </button>
          </form>

          <form className="tbm-subpanel" onSubmit={(event) => void handleVerifyOtp(event)}>
            <h6 className="tbm-subpanel-title">2) Verify OTP</h6>
            <div className="mb-2">
              <label className="form-label">Phone (verifikasi)</label>
              <input
                className="form-control"
                value={telegramVerifyForm.phone}
                onChange={(e) => setTelegramVerifyForm((prev) => ({ ...prev, phone: e.target.value }))}
              />
            </div>
            <div className="mb-2">
              <label className="form-label">OTP Code</label>
              <input
                className="form-control"
                value={telegramVerifyForm.code}
                onChange={(e) => setTelegramVerifyForm((prev) => ({ ...prev, code: e.target.value }))}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={isBusy("otp-verify") || syncing}>
              {isBusy("otp-verify") ? "Memverifikasi..." : "Verifikasi OTP"}
            </button>
          </form>
        </div>

        <div className="table-responsive mt-3">
          <table className="table table-sm align-middle table-bordered">
            <thead className="table-light">
              <tr>
                <th>Label</th>
                <th>Phone</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length ? (
                accounts.map((acc) => (
                  <tr key={acc.id}>
                    <td>{acc.label}</td>
                    <td>{acc.phone}</td>
                    <td>
                      <span className={`badge ${acc.status === "CONNECTED" ? "tbm-status-success" : "tbm-status-warning"}`}>
                        {acc.status}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <TableEmptyRow colSpan={3} message="Belum ada akun Telegram. Mulai dari Request OTP untuk menambahkan akun." />
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderGroupsSection = () => {
    return (
      <>
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">Tambah Group</h5>
          <p className="tbm-panel-desc">Paste link group, username, atau link addlist. Akun yang terhubung otomatis join ke group.</p>

          <form className="mt-3" onSubmit={(event) => void handleAddGroup(event)}>
            <div className="mb-2">
              <label className="form-label">Link / Username Group</label>
              <input
                className="form-control"
                placeholder="https://t.me/namagroup, @username, https://t.me/+hash, atau https://t.me/addlist/slug"
                value={groupAddInput}
                onChange={(e) => setGroupAddInput(e.target.value)}
              />
              <FieldHelp>
                Mendukung: link group publik, @username, link invite private (t.me/+...), dan link folder addlist (t.me/addlist/...).
              </FieldHelp>
            </div>

            {connectedAccounts.length > 1 ? (
              <div className="mb-2">
                <label className="form-label">Akun Telegram</label>
                <select
                  className="form-select"
                  value={groupAddAccountId}
                  onChange={(e) => setGroupAddAccountId(e.target.value)}
                >
                  <option value="">Auto (akun terbaru)</option>
                  {connectedAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>{acc.label} ({acc.phone})</option>
                  ))}
                </select>
              </div>
            ) : null}

            <button
              className="btn btn-primary"
              type="submit"
              disabled={isBusy("group-add") || syncing || !groupAddInput.trim() || !connectedAccounts.length}
            >
              {isBusy("group-add") ? "Memproses & Join..." : "Tambah & Join Group"}
            </button>

            {!connectedAccounts.length ? (
              <div className="alert alert-warning mt-3 mb-0">
                <i className="bi bi-exclamation-triangle me-1"></i>
                Belum ada akun Telegram terhubung. Hubungkan akun dulu di menu <strong>Session Telegram</strong>.
              </div>
            ) : null}
          </form>
        </div>

        <div className="tbm-panel">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h5 className="tbm-panel-title mb-0">Daftar Group</h5>
              <p className="tbm-panel-desc mb-0">{groups.length} group terdaftar, {activeGroupsCount} aktif.</p>
            </div>
            <div className="d-flex align-items-center gap-2">
              <div className="tbm-table-search">
                <i className="bi bi-search tbm-table-search-icon"></i>
                <input
                  type="text"
                  className="tbm-table-search-input"
                  placeholder="Cari group..."
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                />
                {groupSearch ? (
                  <button
                    type="button"
                    className="tbm-table-search-clear"
                    onClick={() => setGroupSearch("")}
                    aria-label="Clear search"
                  >
                    <i className="bi bi-x"></i>
                  </button>
                ) : null}
              </div>
              <span className="tbm-pagination-info">{filteredGroups.length}{groupSearch ? ` / ${groups.length}` : ""}</span>
              <select
                className="tbm-perpage-select"
                value={groupPerPage}
                onChange={(e) => { setGroupPerPage(Number(e.target.value)); setGroupPage(0); }}
              >
                {ROWS_PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
          </div>

          <div className="table-responsive mt-3">
            <table className="table table-sm table-bordered align-middle">
              <thead className="table-light">
                <tr>
                  <th>Group</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {paginatedGroups.length ? (
                  paginatedGroups.map((group) => {
                    const groupToggleKey = `group-toggle-${group.id}`;

                    return (
                      <tr key={group.id}>
                        <td>{group.username ? `@${group.username}` : group.telegramId ?? "-"}</td>
                        <td className="small">{group.title ?? "-"}</td>
                        <td>
                          <span className={`badge ${group.isActive ? "tbm-status-success" : "tbm-status-warning"}`}>
                            {group.isActive ? "ACTIVE" : "INACTIVE"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            type="button"
                            onClick={() => void handleToggleGroup(group.id, group.isActive)}
                            disabled={isBusy(groupToggleKey) || syncing}
                          >
                            {isBusy(groupToggleKey)
                              ? "..."
                              : group.isActive
                                ? "Nonaktifkan"
                                : "Aktifkan"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <TableEmptyRow colSpan={4} message={groupSearch ? "Tidak ada group yang cocok dengan pencarian." : "Belum ada group. Tambahkan group menggunakan form di atas."} />
                )}
              </tbody>
            </table>
          </div>

          {filteredGroups.length > groupPerPage ? (
            <div className="tbm-pagination">
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={groupPage === 0}
                onClick={() => setGroupPage(0)}
                title="Halaman pertama"
              >
                <i className="bi bi-chevron-double-left"></i>
              </button>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={groupPage === 0}
                onClick={() => setGroupPage((p) => Math.max(0, p - 1))}
              >
                <i className="bi bi-chevron-left"></i>
              </button>
              <span className="tbm-pagination-label">
                {groupPage + 1} / {groupTotalPages}
              </span>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={groupPage >= groupTotalPages - 1}
                onClick={() => setGroupPage((p) => Math.min(groupTotalPages - 1, p + 1))}
              >
                <i className="bi bi-chevron-right"></i>
              </button>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={groupPage >= groupTotalPages - 1}
                onClick={() => setGroupPage(groupTotalPages - 1)}
                title="Halaman terakhir"
              >
                <i className="bi bi-chevron-double-right"></i>
              </button>
            </div>
          ) : null}
        </div>
      </>
    );
  };


  const renderTemplatesSection = () => {
    return (
      <>
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">Template Manager</h5>
          <p className="tbm-panel-desc">
            Kelola template pesan untuk broadcast. Mendukung text, media URL, dan spin text seperti {"{promo|diskon|deal}"}.
          </p>

          <form className="tbm-template-editor mt-3" onSubmit={(event) => void handleSaveTemplate(event)}>
            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Buat Template</h6>

              <div className="mb-2">
                <label className="form-label">Template Name</label>
                <input
                  className="form-control"
                  placeholder="Promo Harian"
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="mb-2">
                <label className="form-label">Text</label>
                <textarea
                  className="form-control"
                  rows={7}
                  placeholder="Halo {bro|sis|teman}, cek {promo|diskon|deal} terbaru hari ini."
                  value={templateForm.text}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, text: e.target.value }))}
                />
                <FieldHelp>Gunakan format spin text dengan kurung kurawal dan opsi dipisah pipe.</FieldHelp>
              </div>
            </div>

            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Opsi Template</h6>

              <div className="mb-2">
                <label className="form-label">Media URL (optional)</label>
                <input
                  className="form-control"
                  placeholder="https://..."
                  value={templateForm.mediaUrl}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, mediaUrl: e.target.value }))}
                />
              </div>

              <div className="d-grid gap-2 mt-3">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    checked={templateForm.spinEnabled}
                    onChange={(e) => setTemplateForm((prev) => ({ ...prev, spinEnabled: e.target.checked }))}
                    id="templateSpinEnabled"
                  />
                  <label className="form-check-label" htmlFor="templateSpinEnabled">Aktifkan Spin Text</label>
                </div>

                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    checked={templateForm.isActive}
                    onChange={(e) => setTemplateForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                    id="templateIsActive"
                  />
                  <label className="form-check-label" htmlFor="templateIsActive">Template Active</label>
                </div>
              </div>

              <button className="btn btn-primary mt-3" type="submit" disabled={isBusy("template-save") || syncing}>
                {isBusy("template-save") ? "Menyimpan Template..." : "Simpan Template"}
              </button>
            </div>
          </form>
        </div>

        <div className="tbm-panel">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h5 className="tbm-panel-title mb-0">Template List</h5>
              <p className="tbm-panel-desc mb-0">Pilih template untuk dipakai sebagai pesan broadcast langsung.</p>
            </div>
            <span className="tbm-soft-pill">{templates.length} templates</span>
          </div>

          <div className="tbm-template-grid mt-3">
            {templates.length ? (
              templates.map((template) => {
                const toggleKey = `template-toggle-${template.id}`;
                const deleteKey = `template-delete-${template.id}`;

                return (
                  <article className="tbm-template-card" key={template.id}>
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <div>
                        <h6>{template.name}</h6>
                        <div className="d-flex flex-wrap gap-2 mt-2">
                          <span className={`badge ${template.isActive ? "tbm-status-success" : "tbm-status-warning"}`}>
                            {template.isActive ? "ACTIVE" : "INACTIVE"}
                          </span>
                          {template.spinEnabled ? <span className="badge tbm-status-info">SPIN</span> : null}
                          {template.mediaUrl ? <span className="badge tbm-status-neutral">MEDIA</span> : null}
                        </div>
                      </div>
                    </div>

                    <p className="tbm-template-preview">{template.text || template.mediaUrl || "-"}</p>

                    <div className="d-flex flex-wrap gap-2 mt-auto">
                      <button
                        className="btn btn-sm btn-primary"
                        type="button"
                        onClick={() => handleUseTemplateForBroadcast(template)}
                      >
                        Pakai
                      </button>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        type="button"
                        onClick={() => void handleToggleTemplate(template.id, template.isActive)}
                        disabled={isBusy(toggleKey) || syncing}
                      >
                        {isBusy(toggleKey) ? "Menyimpan..." : template.isActive ? "Nonaktifkan" : "Aktifkan"}
                      </button>
                      <button
                        className="btn btn-sm btn-outline-danger"
                        type="button"
                        onClick={() => void handleDeleteTemplate(template.id)}
                        disabled={isBusy(deleteKey) || syncing}
                      >
                        {isBusy(deleteKey) ? "Menghapus..." : "Hapus"}
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="tbm-empty-state">
                <i className="bi bi-file-earmark-text"></i>
                <strong>Belum ada template</strong>
                <span>Buat template pertama agar broadcast bisa lebih cepat dan konsisten.</span>
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  const estimatedCycles = useMemo(() => {
    const dur = Number(runForm.totalDurationHours);
    const intv = Number(runForm.intervalMinutes);
    if (!dur || !intv || dur <= 0 || intv <= 0) return null;
    return Math.floor((dur * 60) / intv);
  }, [runForm.totalDurationHours, runForm.intervalMinutes]);

  const renderBroadcastSection = () => {
    return (
      <>
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">Mulai Broadcast</h5>
          <p className="tbm-panel-desc">
            Flow: Pilih metode &rarr; Isi pesan &rarr; Atur durasi &amp; interval batch &rarr; Eksekusi.
          </p>

          <div className="mt-2">
            {runBlockers.length ? (
              <div className="alert alert-warning mb-0">
                <div className="fw-semibold mb-1">Preflight belum siap:</div>
                <ul className="mb-0 ps-3">
                  {runBlockers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="alert alert-success mb-0">Preflight lengkap. Kamu bisa langsung manual run broadcast.</div>
            )}
          </div>
        </div>

        {/* ── STEP 1: Metode & Pesan ── */}
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">
            <span className="badge tbm-status-info me-2">Step 1</span>
            Pilih Metode &amp; Isi Pesan
          </h5>
          <div className="mt-2">
            <div className="tbm-subpanel">
              <div className="form-check mb-2">
                <input
                  className="form-check-input"
                  type="radio"
                  name="broadcastMode"
                  id="mode-direct"
                  checked={runForm.mode === "DIRECT_TEXT"}
                  onChange={() => setRunForm((prev) => ({ ...prev, mode: "DIRECT_TEXT" }))}
                />
                <label className="form-check-label" htmlFor="mode-direct">Direct Message</label>
              </div>

              <div className="form-check mb-3">
                <input
                  className="form-check-input"
                  type="radio"
                  name="broadcastMode"
                  id="mode-forward"
                  checked={runForm.mode === "FORWARD_LINK"}
                  onChange={() => setRunForm((prev) => ({ ...prev, mode: "FORWARD_LINK" }))}
                />
                <label className="form-check-label" htmlFor="mode-forward">Forward from Link</label>
              </div>

              {runForm.mode === "DIRECT_TEXT" ? (
                <div>
                  <label className="form-label">Pesan</label>
                  <textarea
                    className="form-control"
                    rows={5}
                    value={runForm.messageText}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, messageText: e.target.value }))}
                    placeholder="Tulis pesan yang akan dikirim ke semua group aktif"
                  />
                  <FieldHelp>Pesan dikirim langsung tanpa template.</FieldHelp>
                </div>
              ) : (
                <div>
                  <label className="form-label">Link Telegram</label>
                  <input
                    className="form-control"
                    value={runForm.messageLink}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, messageLink: e.target.value }))}
                    placeholder="https://t.me/channel/123 atau https://t.me/channel"
                  />
                  <FieldHelp>
                    Bisa link pesan atau link channel/source. Jika hanya source, sistem akan ambil pesan terbaru.
                  </FieldHelp>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── STEP 2: Durasi & Interval Batch ── */}
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">
            <span className="badge tbm-status-info me-2">Step 2</span>
            Durasi &amp; Interval Batch Broadcast
          </h5>
          <p className="tbm-panel-desc">
            Tentukan berapa lama broadcast berjalan dan jarak waktu antar pengiriman ke semua group.
            Kosongkan jika hanya ingin kirim sekali.
          </p>

          <div className="d-grid mt-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Total Durasi Broadcast</h6>
              <div className="mb-2">
                <label className="form-label">Durasi (jam)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  placeholder="Contoh: 24"
                  value={runForm.totalDurationHours}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, totalDurationHours: e.target.value }))}
                />
                <FieldHelp>Berapa jam broadcast akan berjalan. Contoh: 24 = seharian, 48 = 2 hari.</FieldHelp>
              </div>

              <div className="d-flex flex-wrap gap-2 mt-2">
                {[1, 6, 12, 24, 48].map((h) => (
                  <button
                    key={h}
                    type="button"
                    className={`btn btn-sm ${runForm.totalDurationHours === String(h) ? "btn-primary" : "btn-outline-secondary"}`}
                    onClick={() => setRunForm((prev) => ({ ...prev, totalDurationHours: String(h) }))}
                  >
                    {h} jam
                  </button>
                ))}
              </div>
            </div>

            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Interval Antar Broadcast</h6>
              <div className="mb-2">
                <label className="form-label">Interval (menit)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  placeholder="Contoh: 60"
                  value={runForm.intervalMinutes}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, intervalMinutes: e.target.value }))}
                />
                <FieldHelp>Jarak waktu antar pengiriman ke semua group. Contoh: 60 = setiap 1 jam.</FieldHelp>
              </div>

              <div className="d-flex flex-wrap gap-2 mt-2">
                {[15, 30, 60, 120, 180].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`btn btn-sm ${runForm.intervalMinutes === String(m) ? "btn-primary" : "btn-outline-secondary"}`}
                    onClick={() => setRunForm((prev) => ({ ...prev, intervalMinutes: String(m) }))}
                  >
                    {m >= 60 ? `${m / 60} jam` : `${m} menit`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {estimatedCycles !== null && estimatedCycles > 0 ? (
            <div className="alert alert-info mt-3 mb-0">
              <i className="bi bi-info-circle me-1"></i>
              <strong>Estimasi:</strong> Pesan akan dikirim ke semua group sebanyak <strong>~{estimatedCycles} kali</strong> selama {runForm.totalDurationHours} jam
              (setiap {Number(runForm.intervalMinutes) >= 60 ? `${Number(runForm.intervalMinutes) / 60} jam` : `${runForm.intervalMinutes} menit`}).
            </div>
          ) : null}

          {(runForm.totalDurationHours && !runForm.intervalMinutes) || (!runForm.totalDurationHours && runForm.intervalMinutes) ? (
            <div className="alert alert-warning mt-3 mb-0">
              <i className="bi bi-exclamation-triangle me-1"></i>
              Durasi dan interval harus diisi keduanya, atau kosongkan keduanya untuk kirim sekali saja.
            </div>
          ) : null}
        </div>

        {/* ── STEP 3: Eksekusi ── */}
        <div className="tbm-panel">
          <h5 className="tbm-panel-title">
            <span className="badge tbm-status-info me-2">Step 3</span>
            Eksekusi Broadcast
          </h5>
          <div className="d-grid mt-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Pengaturan Run</h6>
              <div className="mb-2">
                <label className="form-label">Nama Broadcast</label>
                <input
                  className="form-control"
                  placeholder="Contoh: Promo Mei, Blast Link Channel, dll"
                  value={runForm.label}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, label: e.target.value }))}
                />
                <FieldHelp>Beri nama agar mudah dikenali di monitoring. Opsional.</FieldHelp>
              </div>
              <div className="mb-2">
                <label className="form-label">Run with Setting</label>
                <select
                  className="form-select"
                  value={runForm.settingId}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, settingId: e.target.value }))}
                >
                  <option value="">Pilih setting</option>
                  {settings.map((setting) => (
                    <option key={setting.id} value={setting.id}>{setting.name}</option>
                  ))}
                </select>
              </div>

              <div className="mb-2">
                <label className="form-label">Run with Account (optional)</label>
                <select
                  className="form-select"
                  value={runForm.accountId}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, accountId: e.target.value }))}
                >
                  <option value="">Auto pilih connected</option>
                  {connectedAccounts.map((acc) => {
                    const busyInfo = busyAccounts.find((b) => b.accountId === acc.id);
                    const isBusyAcc = Boolean(busyInfo);
                    return (
                      <option key={acc.id} value={acc.id} disabled={isBusyAcc}>
                        {acc.label} ({acc.phone}){isBusyAcc ? ` - Sedang dipakai: ${busyInfo!.runLabel || busyInfo!.runId.slice(0, 8)} (${busyInfo!.runStatus})` : ""}
                      </option>
                    );
                  })}
                </select>
                {busyAccounts.length > 0 ? (
                  <div className="tbm-form-help text-warning">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    {busyAccounts.length} akun sedang digunakan broadcast aktif dan tidak bisa dipilih.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="tbm-subpanel">
              <h6 className="tbm-subpanel-title">Ringkasan &amp; Jalankan</h6>
              <div className="mb-2">
                <div className="small text-secondary">
                  <div><strong>Mode:</strong> {runForm.mode === "DIRECT_TEXT" ? "Direct Message" : "Forward from Link"}</div>
                  <div><strong>Target:</strong> {activeGroupsCount} group aktif</div>
                  <div>
                    <strong>Akun:</strong>{" "}
                    {runForm.accountId
                      ? (() => {
                          const selectedAcc = connectedAccounts.find((a) => a.id === runForm.accountId);
                          return selectedAcc ? `${selectedAcc.label} (${selectedAcc.phone})` : "Dipilih";
                        })()
                      : "Auto-select"
                    }
                  </div>
                  {runForm.totalDurationHours && runForm.intervalMinutes ? (
                    <>
                      <div><strong>Durasi:</strong> {runForm.totalDurationHours} jam</div>
                      <div><strong>Interval:</strong> setiap {Number(runForm.intervalMinutes) >= 60 ? `${Number(runForm.intervalMinutes) / 60} jam` : `${runForm.intervalMinutes} menit`}</div>
                      <div><strong>Estimasi cycle:</strong> ~{estimatedCycles ?? 0}x pengiriman</div>
                    </>
                  ) : (
                    <div><strong>Tipe:</strong> Kirim sekali ke semua group</div>
                  )}
                </div>
              </div>

              {/* Warning if selected account is busy */}
              {runForm.accountId && busyAccounts.find((b) => b.accountId === runForm.accountId) ? (
                <div className="alert alert-danger small mb-2">
                  <i className="bi bi-exclamation-triangle me-1"></i>
                  Akun yang dipilih sedang digunakan broadcast lain. Pilih akun lain atau tunggu broadcast selesai.
                </div>
              ) : null}

              <button
                className="btn btn-success mt-2"
                type="button"
                onClick={() => void handleRunBroadcast()}
                disabled={
                  runBlockers.length > 0
                  || isBusy("broadcast-run")
                  || syncing
                  || (Boolean(runForm.totalDurationHours) !== Boolean(runForm.intervalMinutes))
                  || Boolean(runForm.accountId && busyAccounts.find((b) => b.accountId === runForm.accountId))
                }
              >
                {isBusy("broadcast-run")
                  ? "Menjalankan Broadcast..."
                  : runForm.totalDurationHours && runForm.intervalMinutes
                    ? `Mulai Batch Broadcast (${runForm.totalDurationHours}j / ${runForm.intervalMinutes}m)`
                    : "Mulai Manual Broadcast"
                }
              </button>
            </div>
          </div>
        </div>

        <div className="tbm-panel">
          <h5 className="tbm-panel-title">Jadwal Broadcast</h5>
          <p className="tbm-panel-desc">Pilih interval atau cron sebelum broadcast agar pesan bisa dijalankan otomatis sesuai jadwal.</p>

          <form className="mt-2" onSubmit={(event) => void handleCreateSchedule(event)}>
            <div className="d-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
              <div>
                <label className="form-label">Schedule Name</label>
                <input
                  className="form-control"
                  value={scheduleForm.name}
                  onChange={(e) => setScheduleForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="form-label">Type</label>
                <select
                  className="form-select"
                  value={scheduleForm.type}
                  onChange={(e) => setScheduleForm((prev) => ({ ...prev, type: e.target.value as "MANUAL" | "INTERVAL" | "CRON" }))}
                >
                  <option value="MANUAL">MANUAL</option>
                  <option value="INTERVAL">INTERVAL</option>
                  <option value="CRON">CRON</option>
                </select>
              </div>

              {scheduleForm.type === "INTERVAL" ? (
                <div>
                  <label className="form-label">Interval Hours</label>
                  <input
                    className="form-control"
                    type="number"
                    min={1}
                    value={scheduleForm.intervalHours}
                    onChange={(e) => setScheduleForm((prev) => ({ ...prev, intervalHours: e.target.value }))}
                  />
                  <FieldHelp>Contoh: 1 untuk setiap 1 jam.</FieldHelp>
                </div>
              ) : null}

              {scheduleForm.type === "CRON" ? (
                <div>
                  <label className="form-label">Cron Expression</label>
                  <input
                    className="form-control"
                    value={scheduleForm.cronExpr}
                    onChange={(e) => setScheduleForm((prev) => ({ ...prev, cronExpr: e.target.value }))}
                    placeholder="0 */3 * * *"
                  />
                  <FieldHelp>Gunakan jika ingin jadwal lebih spesifik.</FieldHelp>
                </div>
              ) : null}

              <div>
                <label className="form-label">Setting</label>
                <select
                  className="form-select"
                  value={scheduleForm.settingId}
                  onChange={(e) => setScheduleForm((prev) => ({ ...prev, settingId: e.target.value }))}
                >
                  <option value="">Pilih setting</option>
                  {settings.map((setting) => (
                    <option key={setting.id} value={setting.id}>{setting.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <button className="btn btn-primary mt-3" type="submit" disabled={isBusy("schedule-create") || syncing}>
              {isBusy("schedule-create") ? "Membuat Schedule..." : "Buat Jadwal Broadcast"}
            </button>
          </form>
        </div>

        <div className="tbm-panel">
          <h5 className="tbm-panel-title">Broadcast Setting (Sederhana)</h5>
          <form className="mt-2" onSubmit={(event) => void handleSaveSetting(event)}>
            <div className="d-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
              <div>
                <label className="form-label">Setting Name</label>
                <input
                  className="form-control"
                  value={settingForm.name}
                  onChange={(e) => setSettingForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="form-label">Delay Antar Pesan (detik)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  value={settingForm.messageDelaySec}
                  onChange={(e) => setSettingForm((prev) => ({ ...prev, messageDelaySec: Number(e.target.value) || 1 }))}
                />
                <FieldHelp>Nilai ini dipakai sebagai delay tetap antar kirim.</FieldHelp>
              </div>
            </div>

            <div className="d-flex flex-wrap gap-3 mt-3">
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={settingForm.randomizeGroups}
                  onChange={(e) => setSettingForm((prev) => ({ ...prev, randomizeGroups: e.target.checked }))}
                  id="randomizeGroups"
                />
                <label className="form-check-label" htmlFor="randomizeGroups">Randomize Group Order</label>
              </div>

              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={settingForm.autoPauseOnLimit}
                  onChange={(e) => setSettingForm((prev) => ({ ...prev, autoPauseOnLimit: e.target.checked }))}
                  id="autoPauseOnFlood"
                />
                <label className="form-check-label" htmlFor="autoPauseOnFlood">Auto Pause on Flood</label>
              </div>
            </div>

            <button className="btn btn-primary mt-3" type="submit" disabled={isBusy("setting-save") || syncing}>
              {isBusy("setting-save") ? "Menyimpan Setting..." : "Simpan Perubahan Setting"}
            </button>
          </form>
        </div>
      </>
    );
  };

   const renderMonitoringSection = () => {
    const activeRuns = runs.filter((r) => r.status === "RUNNING" || r.status === "PAUSED" || r.status === "PENDING");

    const getAccountLabel = (accountId: string | null) => {
      if (!accountId) return null;
      const acc = accounts.find((a) => a.id === accountId);
      return acc ? `${acc.label} (${acc.phone})` : accountId.slice(0, 8);
    };

    const getEstimatedTotalCycles = (run: RunItem) => {
      if (!run.totalDurationHours || !run.intervalMinutes) return null;
      return Math.floor((run.totalDurationHours * 60) / run.intervalMinutes);
    };

    return (
      <>
        {/* ── Live Monitoring Cards ── */}
        {activeRuns.length > 0 ? (
          <div className="tbm-monitor-grid">
            {activeRuns.map((run) => {
              const info = parseRunMode(run.requestedTemplateIds ?? []);
              const total = run.sentCount + run.failedCount + run.pendingCount;
              const progress = total > 0 ? Math.round((run.sentCount / total) * 100) : 0;
              const statusInfo = runStatusLabel(run);
              const accountLabel = getAccountLabel(run.requestedAccountId);
              const estimatedCyclesTotal = getEstimatedTotalCycles(run);
              const hasBatch = run.totalDurationHours && run.intervalMinutes;

              return (
                <div className="tbm-monitor-card" key={run.id}>
                  <div className="tbm-monitor-card-header">
                    <div>
                      <div className="tbm-monitor-card-label">{run.label || `Run ${run.id.slice(0, 8)}`}</div>
                      <div className="tbm-monitor-card-meta">
                        <span className={runStatusBadgeClass(run.status)}>
                          <i className={`${statusInfo.icon} me-1`}></i>
                          {statusInfo.label}
                        </span>
                        <span className="tbm-monitor-card-mode">{info.mode}</span>
                      </div>
                    </div>
                    <div className="tbm-monitor-card-actions">
                      {run.status === "RUNNING" ? (
                        <>
                          <button className="btn btn-sm btn-outline-warning" type="button" onClick={() => void handleRunAction(run.id, "pause")} disabled={isBusy(`run-pause-${run.id}`) || syncing} title="Jeda broadcast sementara">
                            <i className="bi bi-pause-fill me-1"></i>{isBusy(`run-pause-${run.id}`) ? "..." : "Jeda"}
                          </button>
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(`run-cancel-${run.id}`) || syncing} title="Hentikan broadcast permanen">
                            <i className="bi bi-stop-fill me-1"></i>{isBusy(`run-cancel-${run.id}`) ? "..." : "Stop"}
                          </button>
                        </>
                      ) : null}
                      {run.status === "PAUSED" ? (
                        <>
                          <button className="btn btn-sm btn-outline-success" type="button" onClick={() => void handleRunAction(run.id, "resume")} disabled={isBusy(`run-resume-${run.id}`) || syncing} title="Lanjutkan broadcast">
                            <i className="bi bi-play-fill me-1"></i>{isBusy(`run-resume-${run.id}`) ? "..." : "Lanjutkan"}
                          </button>
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(`run-cancel-${run.id}`) || syncing} title="Hentikan broadcast permanen">
                            <i className="bi bi-stop-fill me-1"></i>{isBusy(`run-cancel-${run.id}`) ? "..." : "Stop"}
                          </button>
                        </>
                      ) : null}
                      {run.status === "PENDING" ? (
                        <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(`run-cancel-${run.id}`) || syncing} title="Batalkan broadcast">
                          <i className="bi bi-x-circle me-1"></i>{isBusy(`run-cancel-${run.id}`) ? "..." : "Batalkan"}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* Status description */}
                  <div className="tbm-monitor-status-detail small">
                    <i className={`${statusInfo.icon} me-1`}></i>
                    {statusInfo.sublabel}
                  </div>

                  {/* Account info */}
                  {accountLabel ? (
                    <div className="tbm-monitor-account small">
                      <i className="bi bi-person-circle me-1"></i>
                      <span>Akun: <strong>{accountLabel}</strong></span>
                    </div>
                  ) : (
                    <div className="tbm-monitor-account small">
                      <i className="bi bi-person-circle me-1"></i>
                      <span>Akun: <em>Auto-select</em></span>
                    </div>
                  )}

                  <div className="tbm-monitor-card-detail small">{info.detail}</div>

                  <div className="tbm-monitor-counters">
                    <div className="tbm-monitor-counter tbm-counter-sent">
                      <span className="tbm-monitor-counter-value">{run.sentCount}</span>
                      <span className="tbm-monitor-counter-label">Terkirim</span>
                    </div>
                    <div className="tbm-monitor-counter tbm-counter-failed">
                      <span className="tbm-monitor-counter-value">{run.failedCount}</span>
                      <span className="tbm-monitor-counter-label">Gagal</span>
                    </div>
                    <div className="tbm-monitor-counter tbm-counter-pending">
                      <span className="tbm-monitor-counter-value">{run.pendingCount}</span>
                      <span className="tbm-monitor-counter-label">Menunggu</span>
                    </div>
                    {hasBatch ? (
                      <div className="tbm-monitor-counter tbm-counter-cycle">
                        <span className="tbm-monitor-counter-value">
                          {run.completedCycles}{estimatedCyclesTotal ? `/${estimatedCyclesTotal}` : ""}
                        </span>
                        <span className="tbm-monitor-counter-label">Siklus</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="tbm-monitor-progress-wrap">
                    <div className="tbm-monitor-progress-bar">
                      <div className="tbm-monitor-progress-fill" style={{ width: `${progress}%` }}></div>
                    </div>
                    <span className="tbm-monitor-progress-text">{progress}%</span>
                  </div>

                  {/* Batch interval info */}
                  {hasBatch ? (
                    <div className="tbm-monitor-batch-info small">
                      <i className="bi bi-arrow-repeat me-1"></i>
                      Batch: {run.totalDurationHours}j durasi, setiap {Number(run.intervalMinutes) >= 60 ? `${Number(run.intervalMinutes) / 60}j` : `${run.intervalMinutes}m`}
                    </div>
                  ) : null}

                  {run.reason ? (
                    <div className={`tbm-monitor-reason small ${
                      run.reason.toLowerCase().includes("waiting") || run.reason.toLowerCase().includes("menunggu")
                        ? "tbm-reason-waiting"
                        : run.reason.toLowerCase().includes("flood") || run.reason.toLowerCase().includes("peer")
                          ? "tbm-reason-warning"
                          : ""
                    }`}>
                      <i className={`${parseRunReason(run.reason).icon} me-1`}></i>
                      {formatReasonShort(run.reason)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="tbm-panel">
            <div className="tbm-success-state">
              <div className="tbm-success-icon-wrap">
                <i className="bi bi-check-circle"></i>
              </div>
              <div>
                <strong>Tidak ada broadcast aktif</strong>
                <p className="mb-0 mt-1 small">Semua broadcast sudah selesai. Jalankan broadcast baru dari menu Broadcast.</p>
              </div>
            </div>
          </div>
        )}

        {/* ── Run History ── */}
        <div className="tbm-panel">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h5 className="tbm-panel-title mb-0">Run History</h5>
              <p className="tbm-panel-desc mb-0">Riwayat semua broadcast yang pernah dijalankan.</p>
            </div>
            <div className="d-flex align-items-center gap-2">
              <span className="tbm-pagination-info">{runs.length} total</span>
              <select
                className="tbm-perpage-select"
                value={runHistoryPerPage}
                onChange={(e) => { setRunHistoryPerPage(Number(e.target.value)); setRunHistoryPage(0); }}
              >
                {ROWS_PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
          </div>

          <div className="table-responsive mt-3">
            <table className="table table-sm table-bordered align-middle">
              <thead className="table-light">
                <tr>
                  <th>Nama</th>
                  <th>Mode / Pesan</th>
                  <th>Akun</th>
                  <th>Status</th>
                  <th>Sent</th>
                  <th>Failed</th>
                  <th>Info</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {paginatedRuns.length ? (
                  paginatedRuns.map((run) => {
                    const pauseKey = `run-pause-${run.id}`;
                    const resumeKey = `run-resume-${run.id}`;
                    const cancelKey = `run-cancel-${run.id}`;
                    const hasBatch = run.totalDurationHours && run.intervalMinutes;
                    const info = parseRunMode(run.requestedTemplateIds ?? []);
                    const statusInfo = runStatusLabel(run);
                    const accountLabel = getAccountLabel(run.requestedAccountId);

                    return (
                      <tr key={run.id}>
                        <td>
                          <div className="fw-semibold" style={{ fontSize: "0.85rem" }}>{run.label || run.id.slice(0, 10)}</div>
                          <div className="text-secondary" style={{ fontSize: "0.72rem" }}>{new Date(run.createdAt).toLocaleString("id-ID")}</div>
                        </td>
                        <td>
                          <span className="badge tbm-status-neutral me-1">{info.mode}</span>
                          <span className="small text-secondary" style={{ maxWidth: 180, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }} title={info.detail}>{info.detail}</span>
                        </td>
                        <td>
                          <span className="small" title={accountLabel ?? "Auto-select"}>
                            <i className="bi bi-person-circle me-1"></i>
                            {accountLabel ? accountLabel : <em className="text-secondary">Auto</em>}
                          </span>
                        </td>
                        <td>
                          <span className={runStatusBadgeClass(run.status)}>
                            <i className={`${statusInfo.icon} me-1`}></i>
                            {statusInfo.label}
                          </span>
                          {statusInfo.sublabel && ["RUNNING", "PAUSED", "PENDING"].includes(run.status) ? (
                            <div className="text-secondary" style={{ fontSize: "0.7rem", marginTop: 2 }}>{statusInfo.sublabel}</div>
                          ) : null}
                        </td>
                        <td>{run.sentCount}</td>
                        <td>{run.failedCount}</td>
                        <td>
                          {hasBatch ? (
                            <span className="small">
                              <i className="bi bi-arrow-repeat me-1"></i>
                              {run.totalDurationHours}j / {run.intervalMinutes}m
                              {run.completedCycles ? ` (${run.completedCycles}x)` : ""}
                            </span>
                          ) : (
                            <span className="text-secondary small">1x kirim</span>
                          )}
                          {run.reason ? (
                            <div className="tbm-reason-detail mt-1" title={run.reason}>
                              <i className={`${parseRunReason(run.reason).icon} me-1`}></i>
                              {formatReasonShort(run.reason)}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div className="d-flex gap-1 flex-wrap">
                            {run.status === "RUNNING" ? (
                              <>
                                <button className="btn btn-sm btn-outline-warning" type="button" onClick={() => void handleRunAction(run.id, "pause")} disabled={isBusy(pauseKey) || syncing} title="Jeda">
                                  <i className="bi bi-pause-fill"></i>
                                </button>
                                <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(cancelKey) || syncing} title="Hentikan">
                                  <i className="bi bi-stop-fill"></i>
                                </button>
                              </>
                            ) : null}
                            {run.status === "PAUSED" ? (
                              <>
                                <button className="btn btn-sm btn-outline-success" type="button" onClick={() => void handleRunAction(run.id, "resume")} disabled={isBusy(resumeKey) || syncing} title="Lanjutkan">
                                  <i className="bi bi-play-fill"></i>
                                </button>
                                <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(cancelKey) || syncing} title="Hentikan">
                                  <i className="bi bi-stop-fill"></i>
                                </button>
                              </>
                            ) : null}
                            {run.status === "PENDING" ? (
                              <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void handleRunAction(run.id, "cancel")} disabled={isBusy(cancelKey) || syncing} title="Batalkan">
                                <i className="bi bi-x-circle"></i>
                              </button>
                            ) : null}
                            {["COMPLETED", "FAILED"].includes(run.status) ? (
                              <span className="text-secondary small">-</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <TableEmptyRow colSpan={8} message="Belum ada riwayat run." />
                )}
              </tbody>
            </table>
          </div>

          {runs.length > runHistoryPerPage ? (
            <div className="tbm-pagination">
              <button className="tbm-pagination-btn" type="button" disabled={runHistoryPage === 0} onClick={() => setRunHistoryPage(0)} title="Halaman pertama"><i className="bi bi-chevron-double-left"></i></button>
              <button className="tbm-pagination-btn" type="button" disabled={runHistoryPage === 0} onClick={() => setRunHistoryPage((p) => Math.max(0, p - 1))}><i className="bi bi-chevron-left"></i></button>
              <span className="tbm-pagination-label">{runHistoryPage + 1} / {runHistoryTotalPages}</span>
              <button className="tbm-pagination-btn" type="button" disabled={runHistoryPage >= runHistoryTotalPages - 1} onClick={() => setRunHistoryPage((p) => Math.min(runHistoryTotalPages - 1, p + 1))}><i className="bi bi-chevron-right"></i></button>
              <button className="tbm-pagination-btn" type="button" disabled={runHistoryPage >= runHistoryTotalPages - 1} onClick={() => setRunHistoryPage(runHistoryTotalPages - 1)} title="Halaman terakhir"><i className="bi bi-chevron-double-right"></i></button>
            </div>
          ) : null}
        </div>

        <div className="tbm-panel">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h5 className="tbm-panel-title mb-0">Send Logs per Sesi Broadcast</h5>
              <p className="tbm-panel-desc mb-0">Pilih sesi broadcast untuk melihat detail log pengiriman dan error per group.</p>
            </div>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <button
                className="btn btn-sm btn-outline-dark"
                type="button"
                onClick={() => void handleExportLogs()}
                disabled={isBusy("logs-export") || syncing || filteredLogs.length === 0}
              >
                {isBusy("logs-export") ? "Mengekspor..." : "Export CSV"}
              </button>
            </div>
          </div>

          {/* ── Session selector ── */}
          <div className="tbm-log-session-filter mt-3">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <label className="form-label mb-0 fw-semibold small">Sesi Broadcast:</label>
              <select
                className="form-select form-select-sm"
                style={{ maxWidth: 360 }}
                value={logRunFilter}
                onChange={(e) => { setLogRunFilter(e.target.value); setSendLogPage(0); }}
              >
                <option value="ALL">Semua Sesi ({sendLogs.length} logs)</option>
                {logRunOptions.map((opt) => {
                  const logCount = sendLogs.filter((l) => l.runId === opt.id).length;
                  return (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} - {opt.accountLabel} [{opt.status}] ({logCount} logs)
                    </option>
                  );
                })}
              </select>
              <select
                className="form-select form-select-sm"
                style={{ width: 110 }}
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value as "ALL" | "FAILED" | "SUCCESS")}
              >
                <option value="ALL">ALL</option>
                <option value="FAILED">FAILED</option>
                <option value="SUCCESS">SUCCESS</option>
              </select>
              <select
                className="tbm-perpage-select"
                value={sendLogPerPage}
                onChange={(e) => { setSendLogPerPage(Number(e.target.value)); setSendLogPage(0); }}
              >
                {ROWS_PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
              <span className="tbm-pagination-info">{filteredLogs.length} logs</span>
            </div>
          </div>

          {/* ── Selected session info card ── */}
          {logRunFilter !== "ALL" ? (() => {
            const selectedOpt = logRunOptions.find((o) => o.id === logRunFilter);
            const selectedRunLogs = sendLogs.filter((l) => l.runId === logRunFilter);
            const successCount = selectedRunLogs.filter((l) => l.status === "SUCCESS").length;
            const failedCount = selectedRunLogs.filter((l) => l.status === "FAILED").length;
            const firstLog = selectedRunLogs[selectedRunLogs.length - 1];
            const runData = firstLog?.run;

            return (
              <div className="tbm-log-session-card mt-3">
                <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                  <div>
                    <div className="fw-semibold">{selectedOpt?.label ?? logRunFilter.slice(0, 8)}</div>
                    <div className="small text-secondary mt-1">
                      <i className="bi bi-person-circle me-1"></i>
                      Akun: <strong>{selectedOpt?.accountLabel ?? "Auto"}</strong>
                    </div>
                    {runData ? (
                      <div className="small text-secondary">
                        <i className="bi bi-calendar3 me-1"></i>
                        Dibuat: {new Date(runData.createdAt).toLocaleString("id-ID")}
                        {runData.totalDurationHours && runData.intervalMinutes ? (
                          <span className="ms-2">
                            <i className="bi bi-arrow-repeat me-1"></i>
                            {runData.totalDurationHours}j / {runData.intervalMinutes}m
                            (siklus {runData.completedCycles}/{Math.floor((runData.totalDurationHours * 60) / runData.intervalMinutes)})
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="d-flex gap-3">
                    <div className="text-center">
                      <div className="fw-bold text-success">{successCount}</div>
                      <div className="small text-secondary">Terkirim</div>
                    </div>
                    <div className="text-center">
                      <div className="fw-bold text-danger">{failedCount}</div>
                      <div className="small text-secondary">Gagal</div>
                    </div>
                    <div className="text-center">
                      <div className="fw-bold">{selectedRunLogs.length}</div>
                      <div className="small text-secondary">Total</div>
                    </div>
                  </div>
                </div>
                {selectedOpt ? (
                  <div className="mt-2">
                    <span className={runStatusBadgeClass(selectedOpt.status as RunItem["status"])}>{selectedOpt.status}</span>
                  </div>
                ) : null}
              </div>
            );
          })() : null}

          <div className="tbm-date-filter mt-3">
            <div className="tbm-date-filter-row">
              <label className="tbm-date-filter-label">Dari</label>
              <input
                type="date"
                className="tbm-date-input"
                value={logDateFrom}
                onChange={(e) => setLogDateFrom(e.target.value)}
              />
              <label className="tbm-date-filter-label">Sampai</label>
              <input
                type="date"
                className="tbm-date-input"
                value={logDateTo}
                onChange={(e) => setLogDateTo(e.target.value)}
              />
              {(logDateFrom || logDateTo) ? (
                <button
                  type="button"
                  className="tbm-date-clear-btn"
                  onClick={() => { setLogDateFrom(""); setLogDateTo(""); }}
                >
                  <i className="bi bi-x-circle"></i> Reset
                </button>
              ) : null}
            </div>
          </div>

          <div className="table-responsive mt-3">
            <table className="table table-sm table-bordered align-middle">
              <thead className="table-light">
                <tr>
                  {logRunFilter === "ALL" ? <th>Sesi</th> : null}
                  <th>Group</th>
                  <th>Akun</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Penjelasan</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {paginatedLogs.length ? (
                  paginatedLogs.map((log) => {
                    const parsed = parseSendLogError(log.errorCode, log.errorMessage);

                    return (
                      <tr key={log.id}>
                        {logRunFilter === "ALL" ? (
                          <td>
                            <button
                              type="button"
                              className="btn btn-link btn-sm p-0 text-start"
                              style={{ fontSize: "0.8rem", textDecoration: "none" }}
                              onClick={() => { setLogRunFilter(log.runId); setSendLogPage(0); }}
                              title={`Filter ke sesi: ${log.run?.label || log.runId.slice(0, 8)}`}
                            >
                              {log.run?.label || log.runId.slice(0, 8)}
                            </button>
                          </td>
                        ) : null}
                        <td>{log.group.username ? `@${log.group.username}` : log.group.telegramId ?? "-"}</td>
                        <td>
                          <span className="small">
                            {log.account ? `${log.account.label}` : <span className="text-secondary">-</span>}
                          </span>
                        </td>
                        <td><span className={statusBadgeClass(log.status)}>{log.status}</span></td>
                        <td>
                          {parsed ? (
                            <span className="tbm-error-label" title={log.errorCode ?? undefined}>{parsed.label}</span>
                          ) : (
                            <span className="text-secondary">-</span>
                          )}
                        </td>
                        <td>
                          {parsed ? (
                            <div className="tbm-error-explain" title={log.errorMessage ?? undefined}>
                              <span>{parsed.explanation}</span>
                            </div>
                          ) : (
                            <span className="text-secondary">-</span>
                          )}
                        </td>
                        <td className="small">{new Date(log.timestamp).toLocaleString("id-ID")}</td>
                      </tr>
                    );
                  })
                ) : (
                  <TableEmptyRow colSpan={logRunFilter === "ALL" ? 7 : 6} message="Belum ada data log untuk filter yang dipilih." />
                )}
              </tbody>
            </table>
          </div>

          {filteredLogs.length > sendLogPerPage ? (
            <div className="tbm-pagination">
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={sendLogPage === 0}
                onClick={() => setSendLogPage(0)}
                title="Halaman pertama"
              >
                <i className="bi bi-chevron-double-left"></i>
              </button>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={sendLogPage === 0}
                onClick={() => setSendLogPage((p) => Math.max(0, p - 1))}
              >
                <i className="bi bi-chevron-left"></i>
              </button>
              <span className="tbm-pagination-label">
                {sendLogPage + 1} / {sendLogTotalPages}
              </span>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={sendLogPage >= sendLogTotalPages - 1}
                onClick={() => setSendLogPage((p) => Math.min(sendLogTotalPages - 1, p + 1))}
              >
                <i className="bi bi-chevron-right"></i>
              </button>
              <button
                className="tbm-pagination-btn"
                type="button"
                disabled={sendLogPage >= sendLogTotalPages - 1}
                onClick={() => setSendLogPage(sendLogTotalPages - 1)}
                title="Halaman terakhir"
              >
                <i className="bi bi-chevron-double-right"></i>
              </button>
            </div>
          ) : null}
        </div>
      </>
    );
  };

  const renderActiveSection = () => {
    switch (activeSection) {
      case "overview":
        return renderOverviewSection();
      case "session":
        return renderSessionSection();
      case "groups":
        return renderGroupsSection();
      case "templates":
        return renderTemplatesSection();
      case "broadcast":
        return renderBroadcastSection();
      case "monitoring":
        return renderMonitoringSection();
      default:
        return renderOverviewSection();
    }
  };

  if (loading) {
    return (
      <main className="tbm-admin-page">
        <div className="tbm-layout">
          <div className="tbm-loading-screen">
            <div className="tbm-loading-spinner"></div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="tbm-admin-page">
      <div className="tbm-layout">
        <div
          className={`tbm-sidebar-overlay ${sidebarOpen ? "tbm-sidebar-overlay-visible" : ""}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        ></div>

        <aside
          className={`tbm-sidebar ${sidebarOpen ? "tbm-sidebar-open" : ""}`}
        >
          <div className="tbm-sidebar-header">
            <a href="#" onClick={(event) => event.preventDefault()} className="tbm-brand-link">
              <div className="tbm-brand-icon">
                <i className="bi bi-broadcast"></i>
              </div>
              <div className="tbm-brand-text">
                <strong>BLAST TELE</strong>
                <small>Broadcast Manager</small>
              </div>
            </a>
          </div>

          <div className="tbm-sidebar-content">
            <nav className="tbm-sidebar-nav">
              {filteredSectionGroups.length ? (
                filteredSectionGroups.map((group) => (
                  <div key={group.label} className="tbm-nav-group">
                    <h3 className="tbm-nav-group-title">{group.label}</h3>
                    <ul className="tbm-nav-list">
                      {group.items.map((sectionId) => {
                        const item = sectionMeta.find((entry) => entry.id === sectionId);
                        if (!item) {
                          return null;
                        }

                        const active = activeSection === item.id;

                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={`tbm-nav-item ${active ? "tbm-nav-item-active" : ""}`}
                              onClick={() => setActiveSection(item.id)}
                            >
                              <span className="tbm-nav-icon">
                                <i className={`bi ${item.icon}`}></i>
                              </span>
                              <span className="tbm-nav-label">{item.label}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <div className="tbm-sidebar-empty">
                  Modul tidak ditemukan untuk kata kunci ini.
                </div>
              )}
            </nav>

            <div className="tbm-sidebar-footer">
              <div className="tbm-sidebar-stats-title">System Snapshot</div>
              <div className="tbm-sidebar-stats">
                <span className="tbm-stat-badge">
                  <i className="bi bi-check-circle"></i>
                  Connected: {connectedAccounts.length}
                </span>
                <span className="tbm-stat-badge">
                  <i className="bi bi-collection"></i>
                  Active Groups: {activeGroupsCount}
                </span>
              </div>
              <button
                type="button"
                className="tbm-logout-btn"
                onClick={handleLogout}
              >
                <i className="bi bi-box-arrow-right"></i>
                Logout
              </button>
            </div>
          </div>
        </aside>

        <div className="tbm-main-area">
          <header className="tbm-topbar">
            <div className="tbm-topbar-inner">
              <div className="tbm-topbar-left">
                <button
                  type="button"
                  className="tbm-topbar-toggle"
                  onClick={() => setSidebarOpen((prev) => !prev)}
                  aria-label="Toggle sidebar"
                >
                  <i className="bi bi-list"></i>
                </button>

                <div className="tbm-topbar-search">
                  <span className="tbm-topbar-search-icon">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="text"
                    placeholder="Search sections..."
                    className="tbm-topbar-search-input"
                    value={topbarSearch}
                    onChange={(event) => setTopbarSearch(event.target.value)}
                  />
                </div>
              </div>

              <div className="tbm-topbar-right">
                <button
                  type="button"
                  className="tbm-topbar-btn"
                  onClick={() => setDarkMode((prev) => !prev)}
                  aria-label="Toggle dark mode"
                >
                  <i className={`bi ${darkMode ? "bi-sun" : "bi-moon"}`}></i>
                </button>
                <button
                  type="button"
                  className="tbm-topbar-btn"
                  aria-label="Notifications"
                >
                  {notificationCount > 0 ? (
                    <span className="tbm-topbar-notification-dot"></span>
                  ) : null}
                  <i className="bi bi-bell"></i>
                </button>
                <div className="tbm-auto-refresh-controls">
                  <button
                    type="button"
                    className="tbm-topbar-btn"
                    onClick={() => void loadAll()}
                    disabled={syncing}
                    aria-label="Refresh data"
                  >
                    <i className={`bi ${syncing ? "bi-arrow-repeat tbm-spin" : "bi-arrow-clockwise"}`}></i>
                  </button>
                  <button
                    type="button"
                    className={`tbm-topbar-btn tbm-auto-refresh-toggle ${autoRefresh ? "tbm-auto-refresh-active" : ""}`}
                    onClick={() => setAutoRefresh((prev) => !prev)}
                    aria-label="Toggle auto refresh"
                    title={autoRefresh ? `Auto-refresh ON (${refreshCountdown}s)` : "Auto-refresh OFF"}
                  >
                    {autoRefresh ? (
                      <span className="tbm-countdown-badge">{refreshCountdown}</span>
                    ) : null}
                    <i className={`bi ${autoRefresh ? "bi-broadcast-pin" : "bi-broadcast"}`}></i>
                  </button>
                  {autoRefresh ? (
                    <select
                      className="tbm-refresh-interval-select"
                      value={autoRefreshInterval}
                      onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
                      title="Interval auto-refresh"
                    >
                      <option value={5}>5s</option>
                      <option value={10}>10s</option>
                      <option value={15}>15s</option>
                      <option value={30}>30s</option>
                      <option value={60}>60s</option>
                    </select>
                  ) : null}
                </div>

                <div className="tbm-topbar-user">
                  <span className="tbm-topbar-user-avatar">AD</span>
                  <span className="tbm-topbar-user-info">
                    <strong>Admin</strong>
                    <small>Broadcast Ops</small>
                  </span>
                </div>
              </div>
            </div>
          </header>

          <main>
            <div className="tbm-page-container">
              <div className="tbm-hero">
                <p className="tbm-hero-breadcrumb">Dashboard / {selectedSectionMeta.label}</p>
                <h1 className="tbm-hero-title">{selectedSectionMeta.label}</h1>
                <p className="tbm-hero-subtitle">{selectedSectionMeta.subtitle}</p>

                <div className="tbm-hero-pills">
                  <span className="tbm-hero-pill">Runs: {runs.length}</span>
                  <span className="tbm-hero-pill">Schedules: {schedules.length}</span>
                  <span className="tbm-hero-pill">Templates: {templates.length}</span>
                  <span className="tbm-hero-pill">Log entries: {sendLogs.length}</span>
                  {lastRefreshedAt ? (
                    <span className="tbm-hero-pill tbm-hero-pill-live">
                      {autoRefresh ? (
                        <span className="tbm-live-dot"></span>
                      ) : null}
                      Terakhir update: {lastRefreshedAt.toLocaleTimeString("id-ID")}
                    </span>
                  ) : null}
                </div>
              </div>

              {error ? (
                <div className="tbm-alert tbm-alert-error">{error}</div>
              ) : null}

              {notice ? (
                <div className="tbm-alert tbm-alert-success">{notice}</div>
              ) : null}

              <div className="tbm-content-stack">{renderActiveSection()}</div>
            </div>
          </main>
        </div>
      </div>
    </main>
  );
}
