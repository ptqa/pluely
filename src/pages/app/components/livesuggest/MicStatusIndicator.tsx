import {
  MicIcon,
  MicOffIcon,
  LoaderIcon,
  AlertCircleIcon,
} from "lucide-react";
import type { MicStatus } from "./LiveSuggestMic";

interface MicStatusIndicatorProps {
  status: MicStatus | null;
  enabled: boolean;
}

export const MicStatusIndicator = ({
  status,
  enabled,
}: MicStatusIndicatorProps) => {
  // Mic is disabled (no STT provider, or session not active).
  if (!enabled) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-muted-foreground"
        title="Microphone is off"
      >
        <MicOffIcon className="h-3 w-3" />
        Mic off
      </span>
    );
  }

  // Mounted but no status reported yet → initializing.
  if (!status || status.loading) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-amber-600"
        title="Loading microphone model..."
      >
        <LoaderIcon className="h-3 w-3 animate-spin" />
        Mic loading
      </span>
    );
  }

  if (status.error) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-red-600 max-w-[180px] truncate"
        title={`Microphone error: ${status.error}`}
      >
        <AlertCircleIcon className="h-3 w-3 flex-shrink-0" />
        Mic error
      </span>
    );
  }

  if (status.speaking) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-blue-600 font-medium"
        title="Hearing your voice"
      >
        <MicIcon className="h-3 w-3 animate-pulse" />
        You: speaking
      </span>
    );
  }

  if (status.listening) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-green-600"
        title="Microphone is listening"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
        Mic listening
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-1 text-[10px] text-muted-foreground"
      title="Microphone idle"
    >
      <MicOffIcon className="h-3 w-3" />
      Mic idle
    </span>
  );
};
