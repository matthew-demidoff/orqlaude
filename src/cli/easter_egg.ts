import { TAGLINES } from "./taglines.js";
import { style } from "../lib/style.js";

/**
 * Bare `orql` easter egg — typewriter cycling through 149 tagline variants
 * beneath the orqlaude diamond. Runs until Ctrl-C / Ctrl-D.
 *
 * v0.9.3 rewrite. Two fixes over the v0.6.1 implementation:
 *
 *   1. **Stdin echo no longer bleeds into the line.** Previously the
 *      terminal was in cooked mode with echo on, so anything the user
 *      typed at the keyboard while the animation ran was printed inline
 *      with the tagline — and the `\b \b` erase pass walked back over
 *      their characters too, leaving partial garbage when the next
 *      tagline started. Now we put stdin in raw mode and silently
 *      swallow every byte except Ctrl-C (0x03) and Ctrl-D (0x04).
 *
 *   2. **Full-screen ownership + resize-aware redraw.** Enters the
 *      alternate screen buffer (\x1b[?1049h, the same mode vim / less /
 *      htop use) so the orqlaude logo claims the entire viewport while
 *      running, with nothing else visible. On exit, the original shell
 *      contents are restored. We repaint the full frame from top-left on
 *      every animation tick AND on `process.stdout` resize events — so
 *      the watermark always lives in the top-left corner regardless of
 *      window size.
 *
 * If stdout isn't a TTY (piped, CI, redirected), we fall back to a
 * single-line static print and exit immediately. Animation only happens
 * when there's an interactive terminal on the other end.
 */

const ESC = "\x1b[";
const ALT_SCREEN_ENTER = `${ESC}?1049h`;
const ALT_SCREEN_LEAVE = `${ESC}?1049l`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_SCREEN = `${ESC}2J`;
const MOVE_TO_HOME = `${ESC}H`;
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

const TYPE_MIN_MS = 28;
const TYPE_MAX_MS = 90;
const HOLD_MIN_MS = 1100;
const HOLD_MAX_MS = 2200;
const ERASE_MIN_MS = 12;
const ERASE_MAX_MS = 30;
const BETWEEN_MIN_MS = 280;
const BETWEEN_MAX_MS = 600;

// Layout: 1-based rows/cols (ANSI convention).
// Row 1: blank padding so the logo doesn't kiss the top edge.
// Row 2-4: logo + wordmark + tagline.
// The tagline starts at column 14 (after `   ◆◆◆      ` which is exactly
// 13 visible chars when the ANSI color codes are stripped: 3 spaces + 3
// glyphs + 6 spaces + 1 = column 14 for the first tagline char).
const LOGO_ROW = 2;
const WORDMARK_ROW = 3;
const TAGLINE_ROW = 4;
const TAGLINE_COL = 14;

export async function runEasterEgg(): Promise<number> {
  // Non-TTY fallback (piped, redirected, CI). No animation, no alt screen.
  if (!process.stdout.isTTY) {
    process.stdout.write(
      `◆ orqlaude — ${TAGLINES[0]}\n`
    );
    return 0;
  }

  return new Promise<number>((resolve) => {
    let stopped = false;
    let currentText = "";

    const cleanup = () => {
      try {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false);
        }
      } catch {
        /* harmless on shutdown */
      }
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      process.stdout.off("resize", onResize);
      process.removeListener("SIGINT", stop);
      process.stdout.write(SHOW_CURSOR + ALT_SCREEN_LEAVE);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      resolve(0);
    };

    // Raw-mode keystroke capture. Every byte is swallowed; Ctrl-C / Ctrl-D
    // exit. This is what stops the user's keyboard from echoing into the
    // animation.
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03 /* Ctrl-C */ || byte === 0x04 /* Ctrl-D */) {
          stop();
          return;
        }
        // All other input is silently discarded.
      }
    };

    // Repaint the full frame from the top-left. Called on every animation
    // tick and on terminal resize. Idempotent.
    const paintFrame = () => {
      const out: string[] = [
        MOVE_TO_HOME,
        CLEAR_SCREEN,
        moveTo(LOGO_ROW, 4),
        style.coral("◆◆◆"),
        moveTo(WORDMARK_ROW, 3),
        style.coral("◆   ◆"),
        "     ",
        style.bold(style.coral("orqlaude")),
        moveTo(TAGLINE_ROW, 4),
        style.coral("◆◆◆"),
        moveTo(TAGLINE_ROW, TAGLINE_COL),
        style.sand(currentText),
      ];
      process.stdout.write(out.join(""));
    };

    const onResize = () => {
      paintFrame();
    };

    // Initial setup.
    process.stdout.write(ALT_SCREEN_ENTER + HIDE_CURSOR);
    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onData);
    } catch {
      /* if raw mode isn't available, we'll only react to SIGINT */
    }
    process.on("SIGINT", stop);
    process.stdout.on("resize", onResize);
    paintFrame();

    // Animation loop.
    (async () => {
      let lastIdx = -1;
      while (!stopped) {
        let idx = Math.floor(Math.random() * TAGLINES.length);
        while (idx === lastIdx) {
          idx = Math.floor(Math.random() * TAGLINES.length);
        }
        lastIdx = idx;
        const tagline = TAGLINES[idx];

        // Type out character by character. Repainting the whole frame
        // each tick is overkill, but it's correct under resize and
        // makes the code easier to reason about than tracking partial
        // updates.
        for (let i = 1; i <= tagline.length; i++) {
          if (stopped) return;
          currentText = tagline.slice(0, i);
          paintFrame();
          await sleep(rand(TYPE_MIN_MS, TYPE_MAX_MS));
        }

        await sleep(rand(HOLD_MIN_MS, HOLD_MAX_MS));
        if (stopped) return;

        for (let i = tagline.length - 1; i >= 0; i--) {
          if (stopped) return;
          currentText = tagline.slice(0, i);
          paintFrame();
          await sleep(rand(ERASE_MIN_MS, ERASE_MAX_MS));
        }

        await sleep(rand(BETWEEN_MIN_MS, BETWEEN_MAX_MS));
      }
    })().catch(() => {
      /* never crash the easter egg */
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
