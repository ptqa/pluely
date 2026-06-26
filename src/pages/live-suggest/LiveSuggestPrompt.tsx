import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Header, Label, Switch } from "@/components";
import { STORAGE_KEYS } from "@/config";
import { getAllSystemPrompts } from "@/lib/database";
import { lsLog, safeLocalStorage } from "@/lib";
import type { SystemPrompt } from "@/types";

export const LiveSuggestPrompt = () => {
  const navigate = useNavigate();
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);
  const [liveSuggestPromptId, setLiveSuggestPromptId] = useState<number | null>(
    () => {
      const stored = safeLocalStorage.getItem(STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID);
      return stored ? Number(stored) : null;
    }
  );
  const [verboseLogs, setVerboseLogs] = useState(
    () => safeLocalStorage.getItem(STORAGE_KEYS.LIVE_SUGGEST_VERBOSE_LOGS) === "true"
  );

  useEffect(() => {
    let mounted = true;
    const loadPrompts = async () => {
      try {
        const result = await getAllSystemPrompts();
        if (mounted) setPrompts(result);
      } catch (err) {
        console.error("Failed to load prompts for Live Suggest:", err);
      }
    };

    void loadPrompts();
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID) return;
      setLiveSuggestPromptId(e.newValue ? Number(e.newValue) : null);
      void loadPrompts();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      mounted = false;
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const activePrompt = liveSuggestPromptId
    ? prompts.find((prompt) => prompt.id === liveSuggestPromptId)
    : null;

  const handleVerboseLogsChange = (checked: boolean) => {
    setVerboseLogs(checked);
    lsLog.setVerbose(checked);
  };

  return (
    <div id="live-suggest-prompt" className="space-y-3">
      <Header
        title="Live Suggest prompt"
        description="Live Suggest now uses the prompt marked in your prompt library and creates card categories dynamically during the conversation."
        isMainTitle
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div>
            <p className="text-sm font-medium">
              {activePrompt ? activePrompt.name : "Built-in adaptive prompt"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              {activePrompt
                ? "This prompt controls Live Suggest's role and focus. The model still invents specific card labels on the fly."
                : "No library prompt is marked for Live Suggest, so the built-in adaptive prompt is used."}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/system-prompts")}
          >
            Open prompts
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div>
            <Label className="text-sm font-medium">Verbose diagnostics</Label>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Log detailed system-audio levels and VAD decisions for troubleshooting.
              Leave this off unless you are debugging capture issues.
            </p>
          </div>
          <Switch
            checked={verboseLogs}
            onCheckedChange={handleVerboseLogsChange}
            aria-label="Toggle Live Suggest verbose diagnostics"
          />
        </div>
      </div>
    </div>
  );
};
