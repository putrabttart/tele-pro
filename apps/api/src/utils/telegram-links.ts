const TELEGRAM_HOSTS = new Set([
  "t.me",
  "www.t.me",
  "telegram.me",
  "www.telegram.me"
]);

const parseUrl = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^t(elegram)?\.me\//i.test(trimmed)
      ? `https://${trimmed}`
      : /^@?[A-Za-z0-9_]+\/\d+$/i.test(trimmed)
        ? `https://t.me/${trimmed.replace(/^@/, "")}`
        : null;

  if (!candidate) {
    return null;
  }

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
};

export const extractAddlistSlug = (value: string) => {
  const directSlug = value.trim();
  if (/^[A-Za-z0-9_-]+$/.test(directSlug) && !directSlug.includes("/")) {
    return directSlug;
  }

  const parsedUrl = parseUrl(value);
  if (!parsedUrl || !TELEGRAM_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return null;
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (pathParts[0] !== "addlist" || !pathParts[1]) {
    return null;
  }

  return pathParts[1];
};

export type ParsedGroupLink = {
  type: "username" | "private_invite" | "addlist";
  /** username (no @), invite hash, or addlist slug */
  value: string;
};

/**
 * Parse any Telegram group link / username into a structured result.
 * Supports:
 *  - @username / username
 *  - https://t.me/username
 *  - https://t.me/+HASH  (private invite)
 *  - https://t.me/joinchat/HASH  (legacy private invite)
 *  - https://t.me/addlist/SLUG  (folder link)
 */
export const parseGroupLink = (input: string): ParsedGroupLink | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pure @username or username (no slashes, no URL)
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(trimmed)) {
    return { type: "username", value: trimmed.replace(/^@/, "") };
  }

  // Try parsing as URL
  const parsedUrl = parseUrl(trimmed);
  if (!parsedUrl || !TELEGRAM_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return null;
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (!pathParts.length) return null;

  // t.me/+HASH (private invite, new format)
  if (pathParts[0].startsWith("+") && pathParts[0].length > 1) {
    return { type: "private_invite", value: pathParts[0].slice(1) };
  }

  // t.me/joinchat/HASH (private invite, legacy format)
  if (pathParts[0] === "joinchat" && pathParts[1]) {
    return { type: "private_invite", value: pathParts[1] };
  }

  // t.me/addlist/SLUG (folder link)
  if (pathParts[0] === "addlist" && pathParts[1]) {
    return { type: "addlist", value: pathParts[1] };
  }

  // t.me/username (public group/channel)
  const username = pathParts[0];
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(username)) {
    return { type: "username", value: username };
  }

  return null;
};

export type ParsedForwardMessageLink = {
  forwardSourceChatId: string;
  forwardMessageId: number;
};

export type ParsedForwardSourceLink = {
  forwardSourceChatId: string;
};

const parseForwardFromPath = (parts: string[]): ParsedForwardMessageLink | null => {
  if (parts.length < 2) {
    return null;
  }

  if (parts[0] === "c" && parts.length >= 3) {
    const chatIdPart = parts[1];
    const messagePart = Number(parts[2]);

    if (!/^\d+$/.test(chatIdPart) || !Number.isInteger(messagePart) || messagePart <= 0) {
      return null;
    }

    return {
      forwardSourceChatId: `-100${chatIdPart}`,
      forwardMessageId: messagePart
    };
  }

  const username = parts[0].replace(/^@/, "");
  const messagePart = Number(parts[1]);

  if (!/^[A-Za-z0-9_]{4,}$/.test(username) || !Number.isInteger(messagePart) || messagePart <= 0) {
    return null;
  }

  return {
    forwardSourceChatId: username,
    forwardMessageId: messagePart
  };
};

export const parseForwardMessageLink = (value: string): ParsedForwardMessageLink | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsedUrl = parseUrl(trimmed);
  if (parsedUrl) {
    if (!TELEGRAM_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    if (parts[0] === "s") {
      return parseForwardFromPath(parts.slice(1));
    }

    return parseForwardFromPath(parts);
  }

  // Support raw format: @channel/123
  if (/^@?[A-Za-z0-9_]+\/\d+$/.test(trimmed)) {
    const [source, message] = trimmed.split("/");
    const forwardMessageId = Number(message);
    if (!Number.isInteger(forwardMessageId) || forwardMessageId <= 0) {
      return null;
    }

    return {
      forwardSourceChatId: source.replace(/^@/, ""),
      forwardMessageId
    };
  }

  return null;
};

export const parseForwardSourceLink = (value: string): ParsedForwardSourceLink | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return {
      forwardSourceChatId: trimmed
    };
  }

  if (/^@?[A-Za-z0-9_]{4,}$/.test(trimmed)) {
    return {
      forwardSourceChatId: trimmed.replace(/^@/, "")
    };
  }

  const parsedUrl = parseUrl(trimmed);
  if (!parsedUrl || !TELEGRAM_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return null;
  }

  const rawParts = parsedUrl.pathname.split("/").filter(Boolean);
  const parts = rawParts[0] === "s" ? rawParts.slice(1) : rawParts;

  if (!parts.length) {
    return null;
  }

  if (parts[0] === "c" && parts[1] && /^\d+$/.test(parts[1])) {
    return {
      forwardSourceChatId: `-100${parts[1]}`
    };
  }

  const username = parts[0].replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{4,}$/.test(username)) {
    return null;
  }

  return {
    forwardSourceChatId: username
  };
};
