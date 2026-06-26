import { OPENAI_CHATGPT_PROVIDER_ID } from "@/config";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";

const OPENAI_CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface ChatGptOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export const getStoredChatGptOAuth = async () => {
  const raw = await invoke<string | null>("chatgpt_oauth_get_token");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ChatGptOAuthToken;
  } catch {
    await removeStoredChatGptOAuth();
    return null;
  }
};

export const saveStoredChatGptOAuth = async (token: ChatGptOAuthToken) => {
  await invoke("chatgpt_oauth_save_token", { value: JSON.stringify(token) });
};

export const removeStoredChatGptOAuth = async () => {
  await invoke("chatgpt_oauth_remove_token");
};

export const startChatGptOAuth = async () => {
  const { authUrl } = await invoke<{ authUrl: string }>("start_chatgpt_oauth");
  await openUrl(authUrl);

  const token = await invoke<ChatGptOAuthToken>("finish_chatgpt_oauth");
  try {
    await saveStoredChatGptOAuth(token);
  } catch (error) {
    throw new Error(
      `ChatGPT sign-in succeeded, but saving tokens to keychain failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return token;
};

export const refreshChatGptOAuthIfNeeded = async () => {
  const token = await getStoredChatGptOAuth();
  if (!token?.refresh) {
    throw new Error("Sign in with ChatGPT Plus/Pro in settings first.");
  }

  if (token.access && token.expires > Date.now() + 60_000) {
    return token;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh,
    client_id: OPENAI_CHATGPT_CLIENT_ID,
  }).toString();

  const response = await tauriFetch(OPENAI_CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to refresh ChatGPT auth: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`
    );
  }

  const json = (await response.json()) as TokenResponse;
  const nextToken: ChatGptOAuthToken = {
    access: json.access_token,
    refresh: json.refresh_token || token.refresh,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
    accountId:
      extractAccountId(json.access_token) ||
      (json.id_token ? extractAccountId(json.id_token) : undefined) ||
      token.accountId,
  };

  await saveStoredChatGptOAuth(nextToken);
  return nextToken;
};

export { OPENAI_CHATGPT_PROVIDER_ID };

const extractAccountId = (token: string) => {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const claims = JSON.parse(atob(padded));

    return (
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    );
  } catch {
    return undefined;
  }
};
