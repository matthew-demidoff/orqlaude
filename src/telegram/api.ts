/**
 * Minimal Telegram Bot API client. Uses fetch (Node 22+ built-in).
 *
 * We use long-polling via getUpdates. Webhooks would require the user to
 * expose a public HTTPS endpoint, which is friction we don't need for a
 * local-developer tool.
 *
 * Docs: https://core.telegram.org/bots/api
 */

const BASE = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramApi {
  constructor(private readonly token: string) {
    if (!token) throw new Error("TelegramApi: bot token is required");
  }

  private endpoint(method: string): string {
    return `${BASE}/bot${this.token}/${method}`;
  }

  /** Long-poll for updates. Resolves when at least one is available or `timeoutSec` elapses. */
  async getUpdates(offset: number, timeoutSec = 30): Promise<TelegramUpdate[]> {
    const url = `${this.endpoint("getUpdates")}?offset=${offset}&timeout=${timeoutSec}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`getUpdates ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string };
    if (!body.ok) throw new Error(`Telegram API error: ${body.description}`);
    return body.result;
  }

  async sendMessage(chatId: number, text: string, opts: { parseMode?: "Markdown" | "HTML" } = {}): Promise<void> {
    const res = await fetch(this.endpoint("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendMessage ${res.status}: ${body}`);
    }
  }

  /** Verify the token works by hitting getMe. Returns the bot's username. */
  async getMe(): Promise<{ username: string; id: number }> {
    const res = await fetch(this.endpoint("getMe"));
    if (!res.ok) throw new Error(`getMe ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { ok: boolean; result: TelegramUser };
    if (!body.ok) throw new Error("getMe failed");
    return { username: body.result.username ?? "<unknown>", id: body.result.id };
  }
}
