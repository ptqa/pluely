/**
 * Lightweight, structured logger for the Live Suggest feature.
 *
 * Logs are prefixed and timestamped so the real-time flow (capture →
 * transcribe → generate → parse) is easy to follow. Each line is written to:
 *   1. the webview DevTools console, and
 *   2. the process stderr (via the `log_message` Tauri command) so it appears
 *      in the same `tauri dev` terminal as the native Rust logs.
 *
 * `debug` output is gated behind a verbose flag (default OFF) that can be
 * toggled at runtime via `localStorage["live_suggest_verbose"] = "true"` or
 * `window.__lsVerbose(true)`.
 */
import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "@/config/constants";

const PREFIX = "%c[LiveSuggest]";
const STYLE = "color:#10b981;font-weight:600";

const readVerbose = (): boolean => {
  try {
    return (
      localStorage.getItem(STORAGE_KEYS.LIVE_SUGGEST_VERBOSE_LOGS) === "true"
    );
  } catch {
    return false;
  }
};

let verbose = readVerbose();

const ts = (): string => new Date().toISOString().slice(11, 23);

// Flatten console-style args into a single string for the terminal.
const stringify = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

// Fire-and-forget forward to the Rust process stderr.
const toTerminal = (level: string, args: unknown[]): void => {
  try {
    void invoke("log_message", {
      level,
      message: `${ts()} ${stringify(args)}`,
    }).catch(() => {});
  } catch {
    /* not running under Tauri */
  }
};

export const lsLog = {
  setVerbose(v: boolean) {
    verbose = v;
    try {
      localStorage.setItem(STORAGE_KEYS.LIVE_SUGGEST_VERBOSE_LOGS, String(v));
    } catch {
      /* ignore */
    }
  },
  isVerbose() {
    return verbose;
  },
  debug(...args: unknown[]) {
    if (!verbose) return;
    // Use console.log (not console.debug) so it shows at the default DevTools
    // level — console.debug is hidden unless "Verbose" is enabled.
    console.log(PREFIX, STYLE, ts(), ...args);
    toTerminal("DEBUG", args);
  },
  info(...args: unknown[]) {
    console.info(PREFIX, STYLE, ts(), ...args);
    toTerminal("INFO", args);
  },
  warn(...args: unknown[]) {
    console.warn(PREFIX, STYLE, ts(), ...args);
    toTerminal("WARN", args);
  },
  error(...args: unknown[]) {
    console.error(PREFIX, STYLE, ts(), ...args);
    toTerminal("ERROR", args);
  },
};

// Convenience toggle from the console.
try {
  (window as unknown as Record<string, unknown>).__lsVerbose = (v: boolean) =>
    lsLog.setVerbose(v);
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.LIVE_SUGGEST_VERBOSE_LOGS) {
      verbose = event.newValue === "true";
    }
  });
} catch {
  /* ignore (non-window environments) */
}

// Startup banner so it's obvious the logger is loaded and where it logs.
lsLog.info(`logger ready (verbose=${verbose}). Toggle debug logs: __lsVerbose(true)`);

/**
 * Error signatures that `fetchAIResponse` / `fetchSTT` emit *as content*
 * instead of throwing. Detecting them lets us surface the real reason a
 * suggestion (or transcription) failed instead of silently producing nothing.
 */
const RESPONSE_ERROR_SIGNATURES = [
  "Pluely API Error:",
  "Pluely STT Error:",
  "Network error during API request:",
  "Network error:",
  "API request failed:",
  "Failed to parse non-streaming response:",
  "Error reading stream:",
  "Streaming not supported or response body missing",
  "Error in fetchAIResponse:",
] as const;

/**
 * Returns a trimmed error message if `text` looks like an API error that was
 * yielded as content, otherwise null.
 */
export const detectResponseError = (text: string): string | null => {
  if (!text) return null;
  const trimmed = text.trim();
  for (const sig of RESPONSE_ERROR_SIGNATURES) {
    const idx = trimmed.indexOf(sig);
    // Match only near the start so legitimate prose can't false-positive.
    if (idx !== -1 && idx < 40) {
      return trimmed.slice(idx);
    }
  }
  // HTTP status style errors, e.g. "HTTP 401: ..." surfaced by STT.
  if (/^HTTP\s+\d{3}\b/.test(trimmed)) return trimmed;
  return null;
};

/** Truncate long strings for log readability. */
export const preview = (text: string, max = 500): string => {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
};
