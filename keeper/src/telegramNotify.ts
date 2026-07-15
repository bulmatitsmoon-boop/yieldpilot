import axios from "axios";
import { logger } from "./logger";

// Alerts-only Telegram channel — compound events, rebalance events. Not a
// general community/chat channel, purely a signal feed (Lloyd's explicit
// framing). Safe to deploy with these env vars unset: every call just no-ops,
// same pattern as LP_VAULT_ADDRESSES being optional elsewhere in this file.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_ALERTS_CHANNEL_ID;

export async function notifyTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHANNEL_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHANNEL_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
  } catch (err: any) {
    // Never let a Telegram outage break the actual keeper cycle.
    logger.warn("Telegram notify error (non-fatal)", {
      error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message,
    });
  }
}
