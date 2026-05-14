import { TAGLINES } from "./taglines.js";
import { style } from "../lib/style.js";

/**
 * Bare `orql` easter egg — a never-repeating typewriter cycling through
 * 149 tagline variants under the orqlaude diamond logo. Runs until Ctrl-C.
 *
 * The natural terminal cursor sits at the end of each tagline while it's
 * displayed and blinks on its own — no explicit blink animation needed.
 */

const ESC = "\x1b[";
const SAVE = `${ESC}s`;
const RESTORE = `${ESC}u`;
const CLEAR_TO_EOL = `${ESC}K`;
const SAND_FG = `${ESC}38;2;185;182;171m`;
const RESET = `${ESC}0m`;

const TYPE_MIN_MS = 28;
const TYPE_MAX_MS = 90;
const HOLD_MIN_MS = 1100;
const HOLD_MAX_MS = 2200;
const ERASE_MIN_MS = 12;
const ERASE_MAX_MS = 30;
const BETWEEN_MIN_MS = 280;
const BETWEEN_MAX_MS = 600;

export async function runEasterEgg(): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopped = false;
    const onSig = () => {
      stopped = true;
      // Move cursor below the tagline line and reset, then exit.
      process.stdout.write(RESET + "\n\n");
      resolve(0);
    };
    process.on("SIGINT", onSig);

    // Static logo + wordmark. Last line ends without a newline so the
    // cursor sits where taglines should animate.
    const logo = [
      `   ${style.coral("◆◆◆")}`,
      `  ${style.coral("◆   ◆")}     ${style.bold(style.coral("orqlaude"))}`,
      `   ${style.coral("◆◆◆")}      `, // trailing spaces are the "padding" before the tagline
    ];
    process.stdout.write("\n" + logo.join("\n"));
    process.stdout.write(SAVE);

    // Animate in a loop. We do this without `await` in the main scope so
    // SIGINT can interrupt cleanly via the `stopped` flag check between
    // sleeps.
    (async () => {
      let lastIdx = -1;
      while (!stopped) {
        let idx = Math.floor(Math.random() * TAGLINES.length);
        // Never repeat the previous tagline.
        while (idx === lastIdx) {
          idx = Math.floor(Math.random() * TAGLINES.length);
        }
        lastIdx = idx;
        const tagline = TAGLINES[idx];

        // Reset cursor + clear any leftover from the previous tagline.
        process.stdout.write(RESTORE + CLEAR_TO_EOL + SAND_FG);

        // Type out character by character. Each char is plain text — the
        // SAND_FG above persists until we reset, so a single \b backspace
        // erases one visible character.
        for (let i = 0; i < tagline.length; i++) {
          if (stopped) return;
          process.stdout.write(tagline[i]);
          await sleep(rand(TYPE_MIN_MS, TYPE_MAX_MS));
        }

        // Hold while the natural terminal cursor blinks at the end.
        await sleep(rand(HOLD_MIN_MS, HOLD_MAX_MS));
        if (stopped) return;

        // Erase backwards for a satisfying "delete" feel.
        for (let i = tagline.length; i > 0; i--) {
          if (stopped) return;
          process.stdout.write("\b \b");
          await sleep(rand(ERASE_MIN_MS, ERASE_MAX_MS));
        }
        process.stdout.write(RESET);
        await sleep(rand(BETWEEN_MIN_MS, BETWEEN_MAX_MS));
      }
    })().catch(() => {
      /* swallow — never crash on the easter egg */
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
