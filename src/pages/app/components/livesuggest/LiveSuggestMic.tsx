import { useEffect } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { floatArrayToWav } from "@/lib/utils";
import type { Speaker } from "@/hooks/useLiveSuggest";

export interface MicStatus {
  loading: boolean;
  listening: boolean;
  speaking: boolean;
  error: string | null;
}

interface LiveSuggestMicProps {
  microphoneDeviceId?: string;
  onSpeech: (speaker: Speaker, audioBlob: Blob) => Promise<void>;
  onStatus?: (status: MicStatus) => void;
}

/**
 * Headless microphone listener for Live Suggest. It runs the browser-side VAD,
 * and on each detected utterance hands the audio to the hook (labelled "you").
 * Mounting/unmounting starts and stops the microphone. It reports its live VAD
 * status upward so the UI can show whether the mic is actually working.
 */
const LiveSuggestMicInternal = ({
  microphoneDeviceId,
  onSpeech,
  onStatus,
}: LiveSuggestMicProps) => {
  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {};

  const vad = useMicVAD({
    // Load VAD model + worklet + onnxruntime WASM from the local app root
    // (copied there by vite-plugin-static-copy) instead of the default CDN,
    // which does not load inside the Tauri webview.
    baseAssetPath: "/",
    onnxWASMBasePath: "/",
    userSpeakingThreshold: 0.6,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    onSpeechEnd: async (audio) => {
      try {
        const audioBlob = floatArrayToWav(audio, 16000, "wav");
        await onSpeech("you", audioBlob);
      } catch (error) {
        console.error("Live Suggest mic transcription failed:", error);
      }
    },
  });

  // Report status upward whenever it changes.
  useEffect(() => {
    onStatus?.({
      loading: vad.loading,
      listening: vad.listening,
      speaking: vad.userSpeaking,
      error: typeof vad.errored === "string" ? vad.errored : null,
    });
  }, [vad.loading, vad.listening, vad.userSpeaking, vad.errored, onStatus]);

  return null;
};

export const LiveSuggestMic = (props: LiveSuggestMicProps) => {
  // Re-mount when the device changes so the VAD picks up the new microphone.
  return <LiveSuggestMicInternal key={props.microphoneDeviceId} {...props} />;
};
