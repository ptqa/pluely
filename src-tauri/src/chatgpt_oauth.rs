use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const KEYCHAIN_SERVICE: &str = "pluely";
const KEYCHAIN_ACCOUNT: &str = "openai_chatgpt_oauth";

#[derive(Default)]
pub struct ChatGptOAuthState {
    pending: Mutex<Option<PendingOAuth>>,
}

struct PendingOAuth {
    state: String,
    code_verifier: String,
    listeners: Vec<TcpListener>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOAuthResponse {
    auth_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishOAuthResponse {
    access: String,
    refresh: String,
    expires: u64,
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
}

#[tauri::command]
pub async fn start_chatgpt_oauth(
    state: State<'_, ChatGptOAuthState>,
) -> Result<StartOAuthResponse, String> {
    let listener = TcpListener::bind("127.0.0.1:1455")
        .await
        .map_err(|e| format!("Failed to start OAuth callback server on localhost:1455. OpenAI's ChatGPT OAuth client only accepts this registered redirect URI. Close any app using that port, such as opencode, and try again. Original error: {e}"))?;
    let mut listeners = vec![listener];
    if let Ok(listener) = TcpListener::bind("[::1]:1455").await {
        listeners.push(listener);
    }

    let oauth_state = Uuid::new_v4().to_string();
    let code_verifier = format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

    let auth_url = format!(
        "https://auth.openai.com/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge_method=S256&code_challenge={}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=opencode&state={}",
        CLIENT_ID,
        percent_encode(REDIRECT_URI),
        percent_encode("openid profile email offline_access"),
        code_challenge,
        oauth_state
    );

    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "OAuth state lock poisoned".to_string())?;
    *pending = Some(PendingOAuth {
        state: oauth_state,
        code_verifier,
        listeners,
    });

    Ok(StartOAuthResponse { auth_url })
}

#[tauri::command]
pub async fn finish_chatgpt_oauth(
    state: State<'_, ChatGptOAuthState>,
) -> Result<FinishOAuthResponse, String> {
    let pending = {
        let mut guard = state
            .pending
            .lock()
            .map_err(|_| "OAuth state lock poisoned".to_string())?;
        guard
            .take()
            .ok_or_else(|| "No ChatGPT OAuth flow is pending".to_string())?
    };

    let code = receive_callback(pending.listeners, &pending.state).await?;

    let token = exchange_code(&code, &pending.code_verifier).await?;
    let refresh = token
        .refresh_token
        .ok_or_else(|| "OAuth response did not include a refresh token".to_string())?;
    let expires = now_millis() + token.expires_in.unwrap_or(3600) * 1000;
    let account_id = extract_account_id(&token.access_token)
        .or_else(|| token.id_token.as_deref().and_then(extract_account_id));

    Ok(FinishOAuthResponse {
        access: token.access_token,
        refresh,
        expires,
        account_id,
    })
}

#[tauri::command]
pub fn chatgpt_oauth_get_token() -> Result<Option<String>, String> {
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Failed to read ChatGPT OAuth token from keychain: {error}"
        )),
    }
}

#[tauri::command]
pub fn chatgpt_oauth_save_token(value: String) -> Result<(), String> {
    keychain_entry()?
        .set_password(&value)
        .map_err(|error| format!("Failed to save ChatGPT OAuth token to keychain: {error}"))
}

#[tauri::command]
pub fn chatgpt_oauth_remove_token() -> Result<(), String> {
    let entry = keychain_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove ChatGPT OAuth token from keychain: {error}"
        )),
    }
}

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("Failed to open ChatGPT OAuth keychain entry: {error}"))
}

async fn receive_callback(
    mut listeners: Vec<TcpListener>,
    expected_state: &str,
) -> Result<String, String> {
    let listener = listeners
        .pop()
        .ok_or_else(|| "OAuth callback server was not started".to_string())?;

    let accept = async move {
        if let Some(other_listener) = listeners.pop() {
            tokio::select! {
                result = listener.accept() => result,
                result = other_listener.accept() => result,
            }
        } else {
            listener.accept().await
        }
    };

    let (mut stream, _) = timeout(Duration::from_secs(300), accept)
        .await
        .map_err(|_| "Timed out waiting for ChatGPT OAuth callback".to_string())?
        .map_err(|e| format!("Failed to accept OAuth callback: {e}"))?;

    let mut buffer = [0_u8; 8192];
    let n = stream
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read OAuth callback: {e}"))?;
    let request = String::from_utf8_lossy(&buffer[..n]);
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| "Invalid OAuth callback request".to_string())?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Invalid OAuth callback path".to_string())?;
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route != "/auth/callback" {
        write_callback_response(&mut stream, false).await;
        return Err("Unexpected OAuth callback path".to_string());
    }

    let params = parse_query(query);
    if let Some(error) = params.get("error") {
        write_callback_response(&mut stream, false).await;
        return Err(format!("ChatGPT OAuth failed: {error}"));
    }

    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "OAuth callback missing code".to_string())?;
    let state = params
        .get("state")
        .cloned()
        .ok_or_else(|| "OAuth callback missing state".to_string())?;
    if state != expected_state {
        write_callback_response(&mut stream, false).await;
        return Err("OAuth state mismatch".to_string());
    }

    write_callback_response(&mut stream, true).await;
    Ok(code)
}

async fn write_callback_response(stream: &mut tokio::net::TcpStream, success: bool) {
    let (title, body) = if success {
        (
            "ChatGPT sign-in complete",
            "You can close this browser tab and return to Pluely.",
        )
    } else {
        (
            "ChatGPT sign-in failed",
            "Return to Pluely and try signing in again.",
        )
    };
    let html = format!(
        "<!doctype html><html><head><title>{}</title></head><body><h1>{}</h1><p>{}</p></body></html>",
        title, title, body
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn exchange_code(code: &str, code_verifier: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read token exchange response: {e}"))?;

    if !status.is_success() {
        return Err(format!("Token exchange failed: {status} - {body}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse token response: {e}"))
}

fn extract_account_id(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;

    claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| auth.get("chatgpt_account_id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| {
            claims
                .get("organizations")
                .and_then(Value::as_array)
                .and_then(|orgs| orgs.first())
                .and_then(|org| org.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(key)?, percent_decode(value)?))
        })
        .collect()
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['%', '2', '0'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let high = from_hex(bytes[i + 1])?;
                let low = from_hex(bytes[i + 2])?;
                result.push(high * 16 + low);
                i += 3;
            }
            b'+' => {
                result.push(b' ');
                i += 1;
            }
            byte => {
                result.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(result).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
