/**
 * Anthropic-palette terminal styling. Uses ANSI 24-bit truecolor escapes so
 * the rendered colors match the brand exactly when the terminal supports it.
 *
 * Brand colors (from Anthropic's public design):
 *   • Claude Coral   #DA7756  — the signature warm orange. Primary brand.
 *   • Cream          #F5F4EE  — soft off-white. Secondary text / surfaces.
 *   • Crimson        #BB5944  — deeper terracotta. Accent / hover.
 *   • Charcoal       #2A2926  — near-black with brown warmth. Body text.
 *   • Dim Sand       #B9B6AB  — muted tan. Captions / disabled.
 *
 * Color is automatically disabled when:
 *   • stdout is not a TTY (piped output)
 *   • NO_COLOR env var is set (https://no-color.org/)
 *   • TERM is "dumb"
 *
 * Use `style.claude("text")` rather than concatenating escape codes directly,
 * so a consumer reading orqlaude's output to a file gets clean text.
 */

const NO_COLOR = !!process.env.NO_COLOR;
const TERM_DUMB = process.env.TERM === "dumb";
const FORCE_COLOR = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0";
const ENABLED = FORCE_COLOR || (!NO_COLOR && !TERM_DUMB && process.stdout.isTTY);

function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

const FG_CORAL = fg(0xda, 0x77, 0x56);
const FG_CREAM = fg(0xf5, 0xf4, 0xee);
const FG_CRIMSON = fg(0xbb, 0x59, 0x44);
const FG_CHARCOAL = fg(0x2a, 0x29, 0x26);
const FG_SAND = fg(0xb9, 0xb6, 0xab);
const BG_CORAL = bg(0xda, 0x77, 0x56);

function wrap(prefix: string, text: string): string {
  if (!ENABLED) return text;
  return `${prefix}${text}${RESET}`;
}

export const style = {
  enabled: ENABLED,
  /** Claude coral — primary brand color. Use for headings + accents. */
  coral: (s: string) => wrap(FG_CORAL, s),
  /** Cream — soft off-white. Use for secondary emphasis. */
  cream: (s: string) => wrap(FG_CREAM, s),
  /** Crimson — deeper terracotta. Use for warnings, accents. */
  crimson: (s: string) => wrap(FG_CRIMSON, s),
  /** Charcoal — near-black warm. Use for body text. */
  charcoal: (s: string) => wrap(FG_CHARCOAL, s),
  /** Sand — muted tan. Use for captions, disabled. */
  sand: (s: string) => wrap(FG_SAND, s),
  /** Coral background — for the orqlaude header banner. */
  coralBg: (s: string) => wrap(`${BG_CORAL}${fg(0x2a, 0x29, 0x26)}`, s),
  bold: (s: string) => wrap(BOLD, s),
  dim: (s: string) => wrap(DIM, s),
  italic: (s: string) => wrap(ITALIC, s),
  underline: (s: string) => wrap(UNDERLINE, s),
};

/** Status-keyed color: maps task/plan status strings to the brand palette. */
export function styleStatus(status: string): (s: string) => string {
  switch (status) {
    case "draft":
    case "estimating":
    case "pending":
      return style.sand;
    case "awaiting_approval":
    case "approved":
    case "dispatching":
      return style.cream;
    case "running":
    case "dispatched":
      return style.coral;
    case "done":
    case "collected":
      return (s) => style.bold(style.coral(s));
    case "failed":
    case "cancelled":
    case "cancelled_overbudget":
      return style.crimson;
    default:
      return (s) => s;
  }
}

/** orqlaude header banner. Shown at the top of `orqlaude` CLI invocations. */
export function banner(): string {
  if (!ENABLED) return "orqlaude";
  return style.coral("◆ ") + style.bold(style.coral("orqlaude")) + style.sand(" — multi-agent orchestrator for Claude Code");
}
