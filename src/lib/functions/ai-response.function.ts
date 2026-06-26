import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import curl2Json from "@bany/curl-to-json";
import { shouldUsePluelyAPI } from "./pluely.api";
import { CHUNK_POLL_INTERVAL_MS } from "../chat-constants";
import {
  OPENAI_CHATGPT_PROVIDER_ID,
  refreshChatGptOAuthIfNeeded,
} from "../openai-chatgpt-oauth";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";

const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

function buildEnhancedSystemPrompt(baseSystemPrompt?: string): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

// Pluely AI streaming function
async function* fetchPluelyAIResponse(params: {
  systemPrompt?: string;
  userMessage: string;
  imagesBase64?: string[];
  history?: Message[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      systemPrompt,
      userMessage,
      imagesBase64 = [],
      history = [],
      signal,
    } = params;

    // Check if already aborted before starting
    if (signal?.aborted) {
      return;
    }

    // Convert history to the expected format
    let historyString: string | undefined;
    if (history.length > 0) {
      // Create a copy before reversing to avoid mutating the original array
      const formattedHistory = [...history].reverse().map((msg) => ({
        role: msg.role,
        content: [{ type: "text", text: msg.content }],
      }));
      historyString = JSON.stringify(formattedHistory);
    }

    // Handle images - can be string or array
    let imageBase64: any = undefined;
    if (imagesBase64.length > 0) {
      imageBase64 = imagesBase64.length === 1 ? imagesBase64[0] : imagesBase64;
    }

    // Set up streaming event listener
    let streamComplete = false;
    const streamChunks: string[] = [];

    const unlisten = await listen("chat_stream_chunk", (event) => {
      const chunk = event.payload as string;
      streamChunks.push(chunk);
    });

    const unlistenComplete = await listen("chat_stream_complete", () => {
      streamComplete = true;
    });

    try {
      // Check if aborted before starting invoke
      if (signal?.aborted) {
        unlisten();
        unlistenComplete();
        return;
      }

      // Start the streaming request using the new API response endpoint
      await invoke("chat_stream_response", {
        userMessage,
        systemPrompt,
        imageBase64,
        history: historyString,
      });

      // Yield chunks as they come in
      let lastIndex = 0;
      while (!streamComplete) {
        // Check if aborted during streaming
        if (signal?.aborted) {
          unlisten();
          unlistenComplete();
          return;
        }

        // Wait a bit for chunks to accumulate
        await new Promise((resolve) =>
          setTimeout(resolve, CHUNK_POLL_INTERVAL_MS)
        );

        // Check again after timeout
        if (signal?.aborted) {
          unlisten();
          unlistenComplete();
          return;
        }

        // Yield any new chunks
        for (let i = lastIndex; i < streamChunks.length; i++) {
          yield streamChunks[i];
        }
        lastIndex = streamChunks.length;
      }

      // Final abort check before yielding remaining chunks
      if (signal?.aborted) {
        unlisten();
        unlistenComplete();
        return;
      }

      // Yield any remaining chunks
      for (let i = lastIndex; i < streamChunks.length; i++) {
        yield streamChunks[i];
      }
    } finally {
      unlisten();
      unlistenComplete();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield `Pluely API Error: ${errorMessage}`;
  }
}

async function* fetchChatGptOAuthResponse(params: {
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  userMessage: string;
  imagesBase64?: string[];
  history?: Message[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const {
    selectedProvider,
    systemPrompt,
    userMessage,
    imagesBase64 = [],
    history = [],
    signal,
  } = params;

  if (signal?.aborted) return;
  if (!userMessage) {
    throw new Error("User message is required");
  }

  const token = await refreshChatGptOAuthIfNeeded();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.access}`,
    "Content-Type": "application/json",
    originator: "opencode",
  };
  if (token.accountId) {
    headers["ChatGPT-Account-Id"] = token.accountId;
  }

  const body = buildChatGptResponsesPayload({
    model: selectedProvider.variables?.model || "gpt-5.5",
    systemPrompt,
    history,
    userMessage,
    imagesBase64,
  });

  let response;
  try {
    response = await tauriFetch(CHATGPT_CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (fetchError) {
    if (
      signal?.aborted ||
      (fetchError instanceof Error && fetchError.name === "AbortError")
    ) {
      return;
    }
    yield `Network error during ChatGPT request: ${
      fetchError instanceof Error ? fetchError.message : "Unknown error"
    }`;
    return;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    yield `ChatGPT request failed: ${response.status} ${response.statusText}${
      errorText ? ` - ${errorText}` : ""
    }`;
    return;
  }

  if (!response.body) {
    yield "ChatGPT streaming response body missing";
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTextDelta = false;

  while (true) {
    if (signal?.aborted) {
      reader.cancel();
      return;
    }

    let readResult;
    try {
      readResult = await reader.read();
    } catch (readError) {
      if (
        signal?.aborted ||
        (readError instanceof Error && readError.name === "AbortError")
      ) {
        return;
      }
      yield `Error reading ChatGPT stream: ${
        readError instanceof Error ? readError.message : "Unknown error"
      }`;
      return;
    }

    const { done, value } = readResult;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;

      const data = line.substring(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        const extracted = extractChatGptStreamText(event, sawTextDelta);
        if (extracted?.text) {
          sawTextDelta ||= extracted.isDelta;
          yield extracted.text;
        }
      } catch {
        // Ignore malformed or partial SSE JSON chunks.
      }
    }
  }
}

function buildChatGptResponsesPayload(params: {
  model: string;
  systemPrompt?: string;
  history: Message[];
  userMessage: string;
  imagesBase64: string[];
}) {
  const { model, systemPrompt, history, userMessage, imagesBase64 } = params;
  const input = history
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: buildChatGptContentParts(message.content, message.role),
    }));

  input.push({
    role: "user",
    content: [
      { type: "input_text", text: userMessage },
      ...imagesBase64.map((image) => ({
        type: "input_image",
        image_url: `data:image/png;base64,${image}`,
      })),
    ],
  });

  return {
    model,
    instructions: systemPrompt || "",
    input,
    stream: true,
    store: false,
  };
}

function buildChatGptContentParts(
  content: Message["content"],
  role: Message["role"]
) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }

  return content
    .map((part) => {
      if (part.text) {
        return { type: textType, text: part.text };
      }
      if (part.image_url?.url && role !== "assistant") {
        return { type: "input_image", image_url: part.image_url.url };
      }
      return null;
    })
    .filter(Boolean);
}

function extractChatGptStreamText(
  event: any,
  sawTextDelta: boolean
): { text: string; isDelta: boolean } | null {
  const eventType = typeof event?.type === "string" ? event.type : "";
  const isDeltaEvent = eventType.includes("delta");

  if (isDeltaEvent) {
    const delta = getFirstStringByPath(event, [
      "delta",
      "delta.text",
      "delta.content",
      "text",
      "content[0].text",
      "item.delta",
      "item.delta.text",
      "response.output_text.delta",
      "choices[0].delta.content",
    ]);
    if (delta) return { text: delta, isDelta: true };
  }

  if (sawTextDelta) return null;

  const doneText = textFromChatGptContent(event?.item?.content);
  if (doneText) return { text: doneText, isDelta: false };

  const text = getFirstStringByPath(event, [
    "output_text",
    "text",
    "response.output_text",
    "response.output[0].content[0].text",
    "item.content[0].text",
    "content[0].text",
  ]);
  return text ? { text, isDelta: false } : null;
}

function getFirstStringByPath(event: any, paths: string[]) {
  for (const path of paths) {
    const value = getByPath(event, path);
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function textFromChatGptContent(content: any): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.text?.value === "string") return part.text.value;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .join("");

  return text || null;
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
    } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt);

    if (selectedProvider?.provider === OPENAI_CHATGPT_PROVIDER_ID) {
      yield* fetchChatGptOAuthResponse({
        selectedProvider,
        systemPrompt: enhancedSystemPrompt,
        userMessage,
        imagesBase64,
        history,
        signal,
      });
      return;
    }

    // Check if we should use Pluely API instead
    const usePluelyAPI = await shouldUsePluelyAPI();
    if (usePluelyAPI) {
      yield* fetchPluelyAIResponse({
        systemPrompt: enhancedSystemPrompt,
        userMessage,
        imagesBase64,
        history,
        signal,
      });
      return;
    }
    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    let url = deepVariableReplacer(curlJson.url || "", allVariables);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    let response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        return; // Silently return on abort
      }
      yield `Network error during API request: ${
        fetchError instanceof Error ? fetchError.message : "Unknown error"
      }`;
      return;
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      yield `API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`;
      return;
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        yield `Failed to parse non-streaming response: ${
          parseError instanceof Error ? parseError.message : "Unknown error"
        }`;
        return;
      }
      const content =
        getByPath(json, provider?.responseContentPath || "") || "";
      yield content;
      return;
    }

    if (!response.body) {
      yield "Streaming not supported or response body missing";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      // Check if aborted
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // Check if aborted
        if (
          signal?.aborted ||
          (readError instanceof Error && readError.name === "AbortError")
        ) {
          return; // Silently return on abort
        }
        yield `Error reading stream: ${
          readError instanceof Error ? readError.message : "Unknown error"
        }`;
        return;
      }
      const { done, value } = readResult;
      if (done) break;

      // Check if aborted before processing
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || ""
            );
            if (delta) {
              yield delta;
            }
          } catch (e) {
            // Ignore parsing errors for partial JSON chunks
          }
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Error in fetchAIResponse: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}
