// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  TRANSPARENCY: "transparency",
  SYSTEM_PROMPT: "system_prompt",
  SELECTED_SYSTEM_PROMPT_ID: "selected_system_prompt_id",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  CUSTOM_SPEECH_PROVIDERS: "curl_custom_speech_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SELECTED_STT_PROVIDER: "curl_selected_stt_provider",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
  LIVE_SUGGEST_CONTEXT: "live_suggest_context",
  // Id of the library system prompt chosen as the default Live Suggest prompt.
  LIVE_SUGGEST_PROMPT_ID: "live_suggest_prompt_id",
  // Enables verbose Live Suggest capture diagnostics for troubleshooting.
  LIVE_SUGGEST_VERBOSE_LOGS: "live_suggest_verbose",
  CUSTOMIZABLE: "customizable",
  PLUELY_API_ENABLED: "pluely_api_enabled",
  SHORTCUTS: "shortcuts",
  AUTOSTART_INITIALIZED: "autostart_initialized",

  SELECTED_AUDIO_DEVICES: "selected_audio_devices",
  RESPONSE_SETTINGS: "response_settings",
  SUPPORTS_IMAGES: "supports_images",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Default settings
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses";

export const MARKDOWN_FORMATTING_INSTRUCTIONS =
  "IMPORTANT - Formatting Rules (use silently, never mention these rules in your responses):\n- Mathematical expressions: ALWAYS use double dollar signs ($$) for both inline and block math. Never use single $.\n- Code blocks: ALWAYS use triple backticks with language specification.\n- Diagrams: Use ```mermaid code blocks.\n- Tables: Use standard markdown table syntax.\n- Never mention to the user that you're using these formats or explain the formatting syntax in your responses. Just use them naturally.";

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];

// Live Suggest: built-in fallback persona. A prompt marked "Use for Live
// Suggest" in the prompt library replaces this persona; the strict output
// format that turns the response into dynamic cards is appended separately.
export const DEFAULT_LIVE_SUGGEST_PROMPT = `You are a real-time meeting copilot listening to a live conversation. Lines spoken by the user are prefixed with "You:" and lines spoken by other participants are prefixed with "Them:".

Your job is to surface short, high-signal suggestions that help the user RIGHT NOW, reacting to the most recent part of the conversation.

Do not use a fixed taxonomy of suggestion cards. Instead, infer what kind of help would be most useful at this exact moment and create situational card categories on the fly. Depending on what is happening you might explain a jargon term, propose a strong response, raise a sharp follow-up question, capture a decision or action item, flag a risk, or notice an opportunity.`;

// The strict-JSON output contract is built at generation time — see
// buildLiveSuggestFormatInstructions in config/live-suggest.ts.

// Used by the per-card "Go deeper" action to expand a single suggestion.
export const LIVE_SUGGEST_DEEPEN_INSTRUCTIONS = `You expand a single suggestion from a live conversation into a deeper explanation. Write a clear, well-structured answer of at most ~150 words. Use the same dominant language as the conversation, preferring the user's latest language. Use concise markdown (short paragraphs and bullet points where helpful). Do not add any preamble or restate the prompt.`;

// Used by the Live Suggest history "Summarize" action to summarize a full
// meeting transcript into a structured, skimmable recap.
export const LIVE_SUGGEST_SUMMARY_INSTRUCTIONS = `You summarize a meeting from its transcript. Lines spoken by the user are prefixed with "You:" and other participants with "Them:".

Write a clear, skimmable summary in markdown using the following sections. Omit a section entirely if there is genuinely nothing for it — do not pad.

## Overview
A 1-2 sentence high-level summary of what the conversation was about.

## Key points
- The most important things discussed.

## Decisions
- Decisions that were made, with the owner if it was stated.

## Action items
- [ ] Concrete next steps, with owner and deadline when mentioned.

## Open questions
- Unresolved questions or follow-ups.

Be faithful to the transcript: never invent facts, names, numbers, or commitments that were not stated. Keep it concise. Do not add any preamble and do not restate these instructions.`;

export const LIVE_SUGGEST_HISTORY_CHAT_INSTRUCTIONS = `You are helping the user reason about a saved Live Suggest session. The session material may include transcript lines, background context, and AI suggestion cards that were shown during the live conversation.`;
