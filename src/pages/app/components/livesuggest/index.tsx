import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from "@/components";
import {
  WandSparklesIcon,
  AlertCircleIcon,
  LoaderIcon,
  XIcon,
  PlusIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/contexts";
import { useLiveSuggestType } from "@/hooks";
import { PermissionFlow } from "../speech/PermissionFlow";
import type { MicStatus } from "./LiveSuggestMic";
import { MicStatusIndicator } from "./MicStatusIndicator";
import { LiveTimeline } from "./LiveTimeline";
import { PromptSelect } from "./PromptSelect";
import { LiveContext } from "./LiveContext";

export const LiveSuggest = (props: useLiveSuggestType) => {
  const {
    active,
    isPanelOpen,
    panelHeight,
    setIsPanelOpen,
    transcript,
    cards,
    deepeningId,
    isGenerating,
    suggestionsPaused,
    isTranscribing,
    systemAudioActive,
    micAudioActive,
    error,
    setupRequired,
    liveSuggestPromptId,
    setLiveSuggestPrompt,
    context,
    addContextText,
    addContextFiles,
    removeContext,
    clearContext,
    start,
    stop,
    reset,
    toggleSuggestionsPaused,
    handleSetup,
    goDeeper,
  } = props;

  const {
    selectedSttProvider,
    selectedAIProvider,
    pluelyApiEnabled,
    supportsImages,
  } = useApp();
  const hasStt = pluelyApiEnabled || !!selectedSttProvider.provider;
  const hasAi = pluelyApiEnabled || !!selectedAIProvider.provider;
  const micEnabled = active && !setupRequired && hasStt;
  const micStatus: MicStatus | null = active
    ? {
        loading: false,
        listening: true,
        speaking: micAudioActive,
        error: null,
      }
    : null;

  const handleToggle = async () => {
    if (active) {
      await stop();
    } else {
      await start();
    }
  };

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-orange-500" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-red-500" />;
    if (isTranscribing || isGenerating)
      return <LoaderIcon className="animate-spin text-primary" />;
    if (active)
      return <WandSparklesIcon className="text-green-500 animate-pulse" />;
    return <WandSparklesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (active) return "Stop Live Suggest";
    return "Start Live Suggest (listen to mic + system audio)";
  };

  return (
    <>
      <Popover
        open={isPanelOpen}
        onOpenChange={(open) => {
          // Don't allow closing the panel while actively capturing; use Stop.
          if (active && !open) return;
          setIsPanelOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            size="icon"
            title={getButtonTitle()}
            onClick={handleToggle}
            className={cn(
              active && "bg-green-50 hover:bg-green-100",
              error && !setupRequired && "bg-red-100 hover:bg-red-200"
            )}
          >
            {getButtonIcon()}
          </Button>
        </PopoverTrigger>

        {(active || setupRequired || error) && (
          <PopoverContent
            align="end"
            side="bottom"
            className="select-none w-screen p-0 border shadow-lg overflow-hidden border-input/50"
            sideOffset={8}
          >
            <div
              className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden"
              style={panelHeight ? { height: `${panelHeight}px` } : undefined}
            >
              {/* Header */}
              <div className="flex-shrink-0 p-3 border-b border-border/50">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <WandSparklesIcon
                          className={cn(
                            "h-4 w-4 text-primary",
                            active && "text-green-500"
                          )}
                        />
                        <h2 className="font-semibold text-sm">Live Suggest</h2>
                      </div>
                      {active && !setupRequired && (
                        <div className="flex items-center gap-2">
                          <MicStatusIndicator
                            status={micStatus}
                            enabled={micEnabled}
                          />
                          <span
                            className={cn(
                              "flex items-center gap-1 text-[10px]",
                              systemAudioActive
                                ? "text-green-600 font-medium"
                                : "text-green-600"
                            )}
                            title={
                              systemAudioActive
                                ? "Hearing speech from system audio"
                                : "System audio is being captured"
                            }
                          >
                            <span
                              className={cn(
                                "inline-block h-1.5 w-1.5 rounded-full",
                                systemAudioActive
                                  ? "bg-green-500 animate-pulse"
                                  : "bg-green-500"
                              )}
                            />
                            {systemAudioActive
                              ? "Them: speaking"
                              : "Them: system audio"}
                          </span>
                          {suggestionsPaused && (
                            <span
                              className="flex items-center gap-1 text-[10px] font-medium text-amber-600"
                              title="Suggestions are paused; transcription continues"
                            >
                              <PauseIcon className="h-3 w-3" />
                              Suggestions paused
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {active && !setupRequired && (
                      <>
                        <PromptSelect
                          value={liveSuggestPromptId}
                          onChange={setLiveSuggestPrompt}
                        />
                        <LiveContext
                          context={context}
                          supportsImages={supportsImages}
                          onAddText={addContextText}
                          onAddFiles={addContextFiles}
                          onRemove={removeContext}
                          onClear={clearContext}
                        />
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!setupRequired && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={reset}
                        className="h-6 text-[10px] gap-1 px-2"
                        title="Clear transcript and suggestions"
                      >
                        <PlusIcon className="w-3 h-3" />
                        New
                      </Button>
                    )}
                    {active ? (
                      <>
                        {!setupRequired && (
                          <Button
                            size="sm"
                            variant={suggestionsPaused ? "default" : "outline"}
                            onClick={toggleSuggestionsPaused}
                            className={cn(
                              "h-6 text-[10px] gap-1 px-2",
                              suggestionsPaused &&
                                "bg-amber-500 text-white hover:bg-amber-600"
                            )}
                            title={
                              suggestionsPaused
                                ? "Resume suggestion generation"
                                : "Pause suggestions while transcription continues"
                            }
                          >
                            {suggestionsPaused ? (
                              <PlayIcon className="w-3 h-3" />
                            ) : (
                              <PauseIcon className="w-3 h-3" />
                            )}
                            {suggestionsPaused ? "Resume" : "Pause"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={stop}
                          className="h-6 text-[10px] gap-1 px-2"
                          title="Stop Live Suggest"
                        >
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        title="Close"
                        onClick={() => setIsPanelOpen(false)}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="p-2 space-y-2">
                  {/* Provider warnings */}
                  {!setupRequired && (!hasStt || !hasAi) && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-orange-50 border border-orange-200">
                      <AlertCircleIcon className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] font-medium text-orange-800">
                          Configuration required
                        </p>
                        <p className="text-[10px] text-orange-700">
                          {!hasStt && "Select a speech-to-text provider. "}
                          {!hasAi && "Select an AI provider. "}
                          Open Dev Space to configure them.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {error && !setupRequired && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200">
                      <AlertCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] font-medium text-red-800">
                          Error
                        </p>
                        <p className="text-[10px] text-red-700">{error}</p>
                      </div>
                    </div>
                  )}

                  {/* Microphone error */}
                  {micEnabled && micStatus?.error && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200">
                      <AlertCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] font-medium text-red-800">
                          Microphone error
                        </p>
                        <p className="text-[10px] text-red-700 break-words">
                          {micStatus.error}
                        </p>
                      </div>
                    </div>
                  )}

                  {setupRequired ? (
                    <PermissionFlow
                      onPermissionGranted={() => handleSetup()}
                      onPermissionDenied={() => {}}
                    />
                  ) : (
                    /* Interleaved transcript + inline suggestion cards. */
                    <LiveTimeline
                      transcript={transcript}
                      cards={cards}
                      isGenerating={isGenerating}
                      isTranscribing={isTranscribing}
                      deepeningId={deepeningId}
                      onGoDeeper={goDeeper}
                    />
                  )}
                </div>
              </ScrollArea>
            </div>
          </PopoverContent>
        )}
      </Popover>
    </>
  );
};
