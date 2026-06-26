import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Resume a stopped Live Suggest session from the dashboard history.
 *
 * Capture runs in the main overlay window (a separate webview from the
 * dashboard), so we signal it via a global Tauri event and then bring the
 * overlay to the foreground (hiding the dashboard) so the live panel is
 * visible.
 */
export async function resumeLiveSuggest(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await emit("live-suggest:resume", { sessionId });
  await invoke("focus_main_window").catch((err) => {
    console.error("Failed to focus main window for resume:", err);
  });
}
