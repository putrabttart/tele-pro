const botToken = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
const chatId = process.env.NOTIFY_TELEGRAM_CHAT_ID;

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

export const notifyTelegram = async (title: string, lines: Array<string | null | undefined>) => {
  if (!botToken || !chatId) return;

  const text = [
    `<b>${escapeHtml(title)}</b>`,
    ...lines.filter((line): line is string => Boolean(line)).map((line) => escapeHtml(line))
  ].join("\n");

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[telegram-notifier] sendMessage failed: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[telegram-notifier] sendMessage error: ${error instanceof Error ? error.message : String(error)}`);
  }
};
