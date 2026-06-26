import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { STORAGE_KEYS } from "@/config";
import { getAllSystemPrompts } from "@/lib/database";
import type { SystemPrompt } from "@/types";

const BUILT_IN_VALUE = "__built_in__";

interface PromptSelectProps {
  value: number | null;
  onChange: (id: number | null) => void;
}

// Compact prompt switcher shown in the Live Suggest overlay header. The prompt
// controls the role/focus; card categories are still generated dynamically.
export const PromptSelect = ({ value, onChange }: PromptSelectProps) => {
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);

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
      if (e.key === STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID) void loadPrompts();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      mounted = false;
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return (
    <Select
      value={value == null ? BUILT_IN_VALUE : String(value)}
      onValueChange={(next) => {
        onChange(next === BUILT_IN_VALUE ? null : Number(next));
      }}
    >
      <SelectTrigger
        size="sm"
        className="!h-6 max-w-44 gap-1 rounded-md px-2 text-[10px] [&_svg]:size-3"
        title="Switch Live Suggest prompt"
      >
        <SelectValue placeholder="Prompt" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={BUILT_IN_VALUE} className="!h-8 text-xs">
          Built-in adaptive
        </SelectItem>
        {prompts.map((prompt) => (
          <SelectItem
            key={prompt.id}
            value={String(prompt.id)}
            className="!h-8 text-xs"
          >
            {prompt.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
