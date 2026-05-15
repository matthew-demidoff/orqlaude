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
  /**
   * v0.10.1+: when the user replies to a bot message, Telegram populates
   * this field with the original. We use `reply_to_message.message_id` to
   * route the reply back to a specific UserResponseRequest, replacing the
   * fragile `/respond <short_id> <text>` convention.
   */
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
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

  async sendMessage(
    chatId: number,
    text: string,
    opts: {
      parseMode?: "Markdown" | "HTML";
      inlineKeyboard?: InlineKeyboardButton[][];
      /**
       * v0.10.1+: enable Telegram's "force reply" UI. When set, tapping the
       * message focuses the chat input and the user's next message becomes a
       * reply-to of this one. Use for questions where we want the user to
       * reply-to (not just press a button).
       */
      forceReply?: boolean;
    } = {}
  ): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode,
      disable_web_page_preview: true,
    };
    if (opts.inlineKeyboard) {
      body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
    } else if (opts.forceReply) {
      // ForceReply prompts the Telegram client to focus its input box with
      // the question pre-selected as a reply target. Selective:false means
      // every chat member sees it (we're in private chats so this is moot).
      body.reply_markup = { force_reply: true, selective: false };
    }
    const res = await fetch(this.endpoint("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`sendMessage ${res.status}: ${text}`);
    }
    const parsed = (await res.json()) as { ok: boolean; result: { message_id: number } };
    return { message_id: parsed.result.message_id };
  }

  /** Acknowledge a callback_query so the Telegram client stops the spinner. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const res = await fetch(this.endpoint("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    if (!res.ok) {
      // Non-fatal: log but don't throw. Telegram will eventually time out the
      // spinner on the client side.
      process.stderr.write(`[orqlaude tg] answerCallbackQuery ${res.status}: ${await res.text()}\n`);
    }
  }

  /** Edit a previously-sent message — used to mark questions as answered. */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parseMode?: "Markdown" | "HTML" } = {}
  ): Promise<void> {
    const res = await fetch(this.endpoint("editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opts.parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[orqlaude tg] editMessageText ${res.status}: ${await res.text()}\n`);
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
