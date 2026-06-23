#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    mpsc::{self, Receiver, RecvTimeoutError},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const KEYCHAIN_SERVICE: &str = "OpenMindSteed";
const MAX_GENERATED_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const TESTED_CODEX_CLI_RANGE: &str = ">=0.142.0 <0.143.0";
const TESTED_CODEX_CLI_MIN: (u64, u64, u64) = (0, 142, 0);
const TESTED_CODEX_CLI_MAX_EXCLUSIVE: (u64, u64, u64) = (0, 143, 0);
const CODEX_METADATA_START: &str = "<openmindsteed_metadata>";
const CODEX_METADATA_END: &str = "</openmindsteed_metadata>";
const STATE_KEY: &str = "mindsteed_state";
const STATE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnRequest {
    request_id: String,
    request: serde_json::Value,
    codex_thread_id: Option<String>,
    codex_bin: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnResponse {
    answer: String,
    title: String,
    summary: String,
    codex_thread_id: String,
    codex_thread_status: String,
    codex_thread_resume_error: Option<String>,
    suggestions: Vec<CodexSuggestion>,
}

#[derive(Debug, Serialize)]
struct CodexSuggestion {
    label: String,
    reason: String,
    priority: u8,
    difficulty: String,
    relation: String,
}

#[derive(Debug, Deserialize)]
struct CodexMetadataBlock {
    title: Option<String>,
    summary: Option<String>,
    suggestions: Option<Vec<CodexMetadataSuggestion>>,
}

#[derive(Debug, Deserialize)]
struct CodexMetadataSuggestion {
    label: Option<String>,
    reason: Option<String>,
    priority: Option<u8>,
    difficulty: Option<String>,
    relation: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexStatusRequest {
    codex_bin: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexCancelRequest {
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexStatusResult {
    binary: String,
    version: String,
    login_status: String,
    logged_in: bool,
    app_server_compatible: bool,
    compatibility_note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreGeneratedImageRequest {
    source_url: String,
    image_id: String,
    mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreGeneratedImageResult {
    local_path: String,
    mime_type: String,
    byte_length: usize,
}

struct CodexExtraction {
    title: String,
    summary: String,
    suggestions: Vec<CodexSuggestion>,
}

struct CodexThreadStart {
    thread_id: String,
    status: String,
    resume_error: Option<String>,
}

static CODEX_CANCELLED_REQUESTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn codex_cancelled_requests() -> &'static Mutex<HashSet<String>> {
    CODEX_CANCELLED_REQUESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn mark_codex_cancelled(request_id: &str) -> Result<(), String> {
    codex_cancelled_requests()
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.to_string());
    Ok(())
}

fn clear_codex_cancel(request_id: &str) {
    if let Ok(mut cancelled) = codex_cancelled_requests().lock() {
        cancelled.remove(request_id);
    }
}

fn is_codex_cancelled(request_id: &str) -> bool {
    codex_cancelled_requests()
        .lock()
        .map(|cancelled| cancelled.contains(request_id))
        .unwrap_or(false)
}

fn ensure_codex_not_cancelled(request_id: &str) -> Result<(), String> {
    if is_codex_cancelled(request_id) {
        Err("Codex request cancelled.".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn store_generated_image_asset(
    app: AppHandle,
    payload: StoreGeneratedImageRequest,
) -> Result<StoreGeneratedImageResult, String> {
    let url = parse_generated_image_source_url(&payload.source_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download generated image: {}", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Image download returned HTTP {}.", status));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_GENERATED_IMAGE_BYTES)
    {
        return Err("Generated image is larger than the 20 MiB local asset limit.".to_string());
    }

    let header_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read generated image bytes: {}", error))?;
    if bytes.len() as u64 > MAX_GENERATED_IMAGE_BYTES {
        return Err("Generated image is larger than the 20 MiB local asset limit.".to_string());
    }

    let mime_type = normalize_image_mime(payload.mime_type.as_deref(), header_mime.as_deref())
        .ok_or_else(|| "Generated image response is not a supported image type.".to_string())?;
    let extension = image_extension_for_mime(&mime_type)
        .ok_or_else(|| "Generated image response is not a supported image type.".to_string())?;
    let image_id = safe_generated_image_id(&payload.image_id);
    let dir = generated_images_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.{}", image_id, extension));
    fs::write(&path, &bytes).map_err(|error| error.to_string())?;

    Ok(StoreGeneratedImageResult {
        local_path: path.to_string_lossy().to_string(),
        mime_type,
        byte_length: bytes.len(),
    })
}

#[tauri::command]
async fn codex_local_turn(
    app: AppHandle,
    payload: CodexTurnRequest,
) -> Result<CodexTurnResponse, String> {
    let request_id = payload.request_id.clone();
    let result = codex_local_turn_impl(app, payload);
    clear_codex_cancel(&request_id);
    result
}

fn codex_local_turn_impl(
    app: AppHandle,
    payload: CodexTurnRequest,
) -> Result<CodexTurnResponse, String> {
    ensure_codex_not_cancelled(&payload.request_id)?;
    let prompt = build_codex_learning_prompt(&payload.request);
    let mut rpc = CodexAppServer::start(payload.codex_bin)?;

    rpc.send_request(
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "openmindsteed",
                "title": "OpenMindSteed",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "optOutNotificationMethods": [
                    "turn/plan/updated",
                    "turn/diff/updated",
                    "item/reasoning/summaryTextDelta",
                    "item/reasoning/textDelta"
                ]
            }
        }),
    )?;
    rpc.wait_response(1, Duration::from_secs(20))?;
    rpc.send_notification("initialized", serde_json::json!({}))?;

    let cwd = std::env::temp_dir().join("openmindsteed-codex-empty-workdir");
    fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
    let thread = rpc.start_or_resume_thread(payload.codex_thread_id, &cwd)?;
    app.emit(
        "codex-local://thread",
        serde_json::json!({
            "requestId": payload.request_id,
            "threadId": &thread.thread_id,
            "threadStatus": &thread.status,
            "resumeError": thread.resume_error.as_deref()
        }),
    )
    .map_err(|error| error.to_string())?;

    rpc.send_request(
        3,
        "turn/start",
        serde_json::json!({
            "threadId": &thread.thread_id,
            "input": [
                {
                    "type": "text",
                    "text": prompt,
                    "text_elements": []
                }
            ],
            "cwd": cwd.to_string_lossy(),
            "approvalPolicy": "never",
            "sandboxPolicy": {
                "mode": "read-only"
            }
        }),
    )?;
    let raw_answer =
        rpc.collect_turn_answer(&app, &payload.request_id, Duration::from_secs(120))?;
    let (answer, structured_extraction) = extract_codex_structured_response(&raw_answer);
    let extraction = structured_extraction
        .unwrap_or_else(|| fallback_codex_extraction(&payload.request, &answer));
    Ok(CodexTurnResponse {
        answer,
        title: extraction.title,
        summary: extraction.summary,
        codex_thread_id: thread.thread_id,
        codex_thread_status: thread.status,
        codex_thread_resume_error: thread.resume_error,
        suggestions: extraction.suggestions,
    })
}

#[tauri::command]
fn codex_local_cancel(payload: CodexCancelRequest) -> Result<(), String> {
    mark_codex_cancelled(&payload.request_id)
}

#[tauri::command]
fn codex_status(payload: CodexStatusRequest) -> Result<CodexStatusResult, String> {
    let candidates = codex_binary_candidates(payload.codex_bin);
    let mut last_error = String::new();
    for candidate in candidates {
        let version = match Command::new(&candidate).arg("--version").output() {
            Ok(output) if output.status.success() => output_text(&output),
            Ok(output) => {
                last_error = format!("{} --version failed: {}", candidate, output_text(&output));
                continue;
            }
            Err(error) => {
                last_error = format!("{}: {}", candidate, error);
                continue;
            }
        };

        let login_output = Command::new(&candidate).args(["login", "status"]).output();
        let (login_status, logged_in) = match login_output {
            Ok(output) => {
                let text = output_text(&output);
                let logged_in =
                    output.status.success() && text.to_lowercase().contains("logged in");
                (text, logged_in)
            }
            Err(error) => (
                format!("Could not check Codex login status: {}", error),
                false,
            ),
        };

        let compatibility = codex_cli_compatibility(&version);
        return Ok(CodexStatusResult {
            binary: candidate,
            version,
            login_status,
            logged_in,
            app_server_compatible: compatibility.0,
            compatibility_note: compatibility.1,
        });
    }

    Err(codex_missing_binary_error(&last_error))
}

struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Result<String, String>>,
}

impl CodexAppServer {
    fn start(codex_bin: Option<String>) -> Result<Self, String> {
        let candidates = codex_binary_candidates(codex_bin);
        let mut last_error = String::new();
        for candidate in candidates {
            match Command::new(&candidate)
                .args(["app-server", "--listen", "stdio://"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(mut child) => {
                    let stdin = child
                        .stdin
                        .take()
                        .ok_or_else(|| "Could not open Codex app-server stdin.".to_string())?;
                    let stdout = child
                        .stdout
                        .take()
                        .ok_or_else(|| "Could not open Codex app-server stdout.".to_string())?;
                    let stderr = child.stderr.take();
                    let (tx, rx) = mpsc::channel();
                    std::thread::spawn(move || {
                        for line in BufReader::new(stdout).lines() {
                            if tx.send(line.map_err(|error| error.to_string())).is_err() {
                                break;
                            }
                        }
                    });
                    if let Some(stderr) = stderr {
                        std::thread::spawn(move || {
                            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                                eprintln!("codex app-server: {}", line);
                            }
                        });
                    }
                    return Ok(Self {
                        child,
                        stdin,
                        lines: rx,
                    });
                }
                Err(error) => {
                    last_error = format!("{}: {}", candidate, error);
                }
            }
        }
        Err(format!(
            "Could not start Codex app-server. {}",
            codex_missing_binary_error(&last_error)
        ))
    }

    fn send_notification(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.write_message(serde_json::json!({ "method": method, "params": params }))
    }

    fn send_request(
        &mut self,
        id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), String> {
        self.write_message(serde_json::json!({
            "id": id,
            "method": method,
            "params": params
        }))
    }

    fn send_request_wait(
        &mut self,
        id: u64,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.send_request(id, method, params)?;
        self.wait_response(id, timeout)
    }

    fn start_or_resume_thread(
        &mut self,
        codex_thread_id: Option<String>,
        cwd: &Path,
    ) -> Result<CodexThreadStart, String> {
        let mut resume_error = None;
        if let Some(thread_id) = codex_thread_id.filter(|value| !value.trim().is_empty()) {
            let response = self.send_request_wait(
                2,
                "thread/resume",
                serde_json::json!({
                    "threadId": thread_id,
                    "cwd": cwd.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "baseInstructions": "You are a learning tutor embedded in OpenMindSteed. Do not edit files, run commands, inspect the repository, or perform coding work. Only answer the user's learning question in Chinese."
                }),
                Duration::from_secs(30),
            );
            match response {
                Ok(response) => {
                    if let Some(id) = extract_thread_id(&response) {
                        return Ok(CodexThreadStart {
                            thread_id: id.to_string(),
                            status: "resumed".to_string(),
                            resume_error: None,
                        });
                    }
                    resume_error = Some(format!(
                        "thread/resume returned no thread id: {}",
                        truncate_codex_diagnostic(&response.to_string(), 300)
                    ));
                }
                Err(error) => {
                    resume_error = Some(truncate_codex_diagnostic(&error, 300));
                }
            }
        }

        let response = self.send_request_wait(
            2,
            "thread/start",
            serde_json::json!({
                "cwd": cwd.to_string_lossy(),
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "baseInstructions": "You are a learning tutor embedded in OpenMindSteed. Do not edit files, run commands, inspect the repository, or perform coding work. Only answer the user's learning question in Chinese."
            }),
            Duration::from_secs(30),
        )?;
        let thread_id = extract_thread_id(&response)
            .map(ToString::to_string)
            .ok_or_else(|| format!("Codex app-server did not return a thread id: {}", response))?;
        Ok(CodexThreadStart {
            thread_id,
            status: if resume_error.is_some() {
                "resume-fallback".to_string()
            } else {
                "started".to_string()
            },
            resume_error,
        })
    }

    fn write_message(&mut self, message: serde_json::Value) -> Result<(), String> {
        writeln!(self.stdin, "{}", message).map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }

    fn wait_response(&mut self, id: u64, timeout: Duration) -> Result<serde_json::Value, String> {
        loop {
            let message = self.read_json(timeout)?;
            if message.get("id").and_then(|value| value.as_u64()) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("Codex app-server error: {}", error));
            }
            return Ok(message);
        }
    }

    fn collect_turn_answer(
        &mut self,
        app: &AppHandle,
        request_id: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let mut answer = String::new();
        loop {
            ensure_codex_not_cancelled(request_id)?;
            let message = self.read_json_cancellable(timeout, request_id)?;
            match message.get("method").and_then(|method| method.as_str()) {
                Some("item/agentMessage/delta") => {
                    if let Some(delta) = message
                        .get("params")
                        .and_then(|params| params.get("delta"))
                        .and_then(|delta| delta.as_str())
                    {
                        answer.push_str(delta);
                        emit_codex_delta(app, request_id, delta)?;
                    }
                }
                Some(method)
                    if method == "item/completed" || method == "item/agentMessage/completed" =>
                {
                    if let Some(final_text) = extract_completed_agent_message_text(&message) {
                        if let Some(delta) =
                            reconcile_completed_agent_text(&mut answer, &final_text)
                        {
                            emit_codex_delta(app, request_id, &delta)?;
                        }
                    } else if let Some(status) = blocked_codex_tool_work_event(&message) {
                        emit_codex_status(app, request_id, &status)?;
                        return Err(codex_blocked_tool_work_error(&status));
                    }
                }
                Some("item/started") => {
                    if let Some(status) = blocked_codex_tool_work_event(&message) {
                        emit_codex_status(app, request_id, &status)?;
                        return Err(codex_blocked_tool_work_error(&status));
                    }
                }
                Some(method) if codex_item_status_from_method(method).is_some() => {
                    if let Some(status) = blocked_codex_tool_work_event(&message) {
                        emit_codex_status(app, request_id, &status)?;
                        return Err(codex_blocked_tool_work_error(&status));
                    }
                }
                Some("turn/completed") => {
                    return if answer.trim().is_empty() {
                        Err("Codex completed without an agent message.".to_string())
                    } else {
                        Ok(answer)
                    };
                }
                Some("error") => {
                    return Err(format!(
                        "Codex app-server notification error: {}",
                        message.get("params").unwrap_or(&serde_json::Value::Null)
                    ));
                }
                _ => {
                    if let Some(error) = message.get("error") {
                        return Err(format!("Codex app-server error: {}", error));
                    }
                }
            }
        }
    }

    fn read_json(&mut self, timeout: Duration) -> Result<serde_json::Value, String> {
        let line = self
            .lines
            .recv_timeout(timeout)
            .map_err(|_| "Timed out waiting for Codex app-server.".to_string())?
            .map_err(|error| format!("Codex app-server stdout error: {}", error))?;
        serde_json::from_str(&line)
            .map_err(|error| format!("Bad Codex JSON: {}; line={}", error, line))
    }

    fn read_json_cancellable(
        &mut self,
        timeout: Duration,
        request_id: &str,
    ) -> Result<serde_json::Value, String> {
        let started = Instant::now();
        loop {
            ensure_codex_not_cancelled(request_id)?;
            if started.elapsed() >= timeout {
                return Err("Timed out waiting for Codex app-server.".to_string());
            }
            match self.lines.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    let line =
                        line.map_err(|error| format!("Codex app-server stdout error: {}", error))?;
                    return serde_json::from_str(&line)
                        .map_err(|error| format!("Bad Codex JSON: {}; line={}", error, line));
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("Codex app-server stdout closed.".to_string());
                }
            }
        }
    }
}

impl Drop for CodexAppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn extract_thread_id(response: &serde_json::Value) -> Option<&str> {
    response
        .get("result")
        .and_then(|result| result.get("thread"))
        .and_then(|thread| thread.get("id"))
        .and_then(|id| id.as_str())
}

fn emit_codex_delta(app: &AppHandle, request_id: &str, delta: &str) -> Result<(), String> {
    app.emit(
        "codex-local://delta",
        serde_json::json!({
            "requestId": request_id,
            "delta": delta
        }),
    )
    .map_err(|error| error.to_string())
}

#[derive(Debug)]
struct CodexStatusEvent {
    status: String,
    kind: String,
    label: String,
    severity: String,
}

fn emit_codex_status(
    app: &AppHandle,
    request_id: &str,
    status: &CodexStatusEvent,
) -> Result<(), String> {
    app.emit(
        "codex-local://status",
        serde_json::json!({
            "requestId": request_id,
            "status": &status.status,
            "kind": &status.kind,
            "label": &status.label,
            "severity": &status.severity
        }),
    )
    .map_err(|error| error.to_string())
}

fn reconcile_completed_agent_text(answer: &mut String, final_text: &str) -> Option<String> {
    let final_text = final_text.trim();
    if final_text.is_empty() {
        return None;
    }
    if answer.is_empty() {
        answer.push_str(final_text);
        return Some(final_text.to_string());
    }
    if final_text == answer {
        return None;
    }
    if final_text.starts_with(answer.as_str()) {
        let suffix = final_text[answer.len()..].to_string();
        answer.push_str(&suffix);
        return (!suffix.is_empty()).then_some(suffix);
    }
    if final_text.chars().count() > answer.chars().count() {
        answer.clear();
        answer.push_str(final_text);
    }
    None
}

fn extract_completed_agent_message_text(message: &serde_json::Value) -> Option<String> {
    if !is_agent_message_notification(message) {
        return None;
    }
    let params = message.get("params").unwrap_or(message);
    let payload = params
        .get("item")
        .or_else(|| params.get("message"))
        .unwrap_or(params);
    let mut chunks = Vec::new();
    collect_text_payload(payload, &mut chunks);
    let text = chunks.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn extract_codex_status_event(
    message: &serde_json::Value,
    status: &str,
) -> Option<CodexStatusEvent> {
    if is_agent_message_notification(message) {
        return None;
    }
    let params = message.get("params").unwrap_or(message);
    let item = params.get("item").unwrap_or(params);
    let kind = item_kind(item)?;
    if !is_reportable_codex_item_kind(&kind) {
        return None;
    }
    Some(CodexStatusEvent {
        status: status.to_string(),
        kind,
        label: item_label(item),
        severity: "info".to_string(),
    })
}

fn blocked_codex_tool_work_event(message: &serde_json::Value) -> Option<CodexStatusEvent> {
    let mut event = extract_codex_status_event(message, "blocked")?;
    event.severity = "warning".to_string();
    Some(event)
}

fn codex_item_status_from_method(method: &str) -> Option<&'static str> {
    match method {
        "item/started" => Some("started"),
        "item/completed" | "item/agentMessage/completed" => Some("completed"),
        "item/updated" => Some("updated"),
        "item/failed" => Some("failed"),
        _ => None,
    }
}

fn codex_blocked_tool_work_error(status: &CodexStatusEvent) -> String {
    let kind = status.kind.replace('_', " ").replace('-', " ");
    let label = status.label.trim();
    let suffix = if label.is_empty() {
        String::new()
    } else {
        format!(" ({})", label)
    };
    format!(
        "Codex Local tried to perform {}{} during a learning-only turn. The turn was stopped to avoid local tool or command work.",
        kind, suffix
    )
}

fn is_agent_message_notification(message: &serde_json::Value) -> bool {
    let method = message
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if method.contains("agentMessage") {
        return true;
    }
    let params = message.get("params").unwrap_or(message);
    let item = params.get("item").unwrap_or(params);
    string_field_contains(item, "type", "agent")
        || string_field_contains(item, "kind", "agent")
        || string_field_contains(item, "role", "assistant")
}

fn string_field_contains(value: &serde_json::Value, key: &str, needle: &str) -> bool {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .map(|field| field.to_lowercase().contains(needle))
        .unwrap_or(false)
}

fn item_kind(value: &serde_json::Value) -> Option<String> {
    for key in ["type", "kind", "role"] {
        if let Some(kind) = value.get(key).and_then(|field| field.as_str()) {
            let trimmed = kind.trim();
            if !trimmed.is_empty() {
                return Some(truncate_codex_diagnostic(trimmed, 64));
            }
        }
    }
    None
}

fn is_reportable_codex_item_kind(kind: &str) -> bool {
    let normalized = kind.to_lowercase();
    ["command", "tool", "file", "diff", "patch", "shell"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

fn item_label(value: &serde_json::Value) -> String {
    for key in ["title", "name", "command", "text", "message"] {
        if let Some(label) = value.get(key).and_then(|field| field.as_str()) {
            let trimmed = label.trim();
            if !trimmed.is_empty() {
                return truncate_codex_diagnostic(trimmed, 140);
            }
        }
    }
    String::new()
}

fn collect_text_payload(value: &serde_json::Value, chunks: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                chunks.push(trimmed.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_payload(item, chunks);
            }
        }
        serde_json::Value::Object(object) => {
            for key in ["text", "content", "message"] {
                if let Some(child) = object.get(key) {
                    collect_text_payload(child, chunks);
                }
            }
        }
        _ => {}
    }
}

fn codex_binary_candidates(configured: Option<String>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(value) = configured {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }
    if let Ok(value) = std::env::var("OPENMINDSTEED_CODEX_BIN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }
    candidates.push("codex".to_string());
    candidates.push("/Applications/Codex.app/Contents/Resources/codex".to_string());
    candidates.dedup();
    candidates
}

fn codex_missing_binary_error(last_error: &str) -> String {
    let last_error = truncate_codex_diagnostic(last_error, 220);
    let suffix = if last_error.is_empty() {
        String::new()
    } else {
        format!(" Last error: {}", last_error)
    };
    format!(
        "Could not locate a working Codex binary. Install Codex, make sure `codex` is on PATH, set OPENMINDSTEED_CODEX_BIN, or enter the Codex binary path in Settings.{}",
        suffix
    )
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{}\n{}", stdout, stderr),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    }
}

fn codex_cli_compatibility(version_text: &str) -> (bool, String) {
    let Some(version) = parse_codex_cli_version(version_text) else {
        return (
            false,
            format!(
                "Could not parse Codex CLI version. Tested range: {}.",
                TESTED_CODEX_CLI_RANGE
            ),
        );
    };
    if version >= TESTED_CODEX_CLI_MIN && version < TESTED_CODEX_CLI_MAX_EXCLUSIVE {
        (
            true,
            format!("Within tested Codex CLI range {}.", TESTED_CODEX_CLI_RANGE),
        )
    } else {
        (
            false,
            format!(
                "Outside tested Codex CLI range {}. app-server may still work, but this build has not verified it.",
                TESTED_CODEX_CLI_RANGE
            ),
        )
    }
}

fn parse_codex_cli_version(version_text: &str) -> Option<(u64, u64, u64)> {
    version_text.split_whitespace().find_map(parse_semver_token)
}

fn parse_semver_token(token: &str) -> Option<(u64, u64, u64)> {
    let normalized = token
        .trim()
        .trim_start_matches('v')
        .trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
    let mut parts = normalized.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn parse_generated_image_source_url(source_url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(source_url.trim())
        .map_err(|error| format!("Generated image URL is invalid: {}", error))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!(
            "Refusing to download generated image from unsupported URL scheme: {}",
            scheme
        )),
    }
}

fn generated_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("generated-images"))
}

fn safe_generated_image_id(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect::<String>();
    if sanitized.is_empty() {
        format!("image-{}", deleted_batch_name())
    } else {
        sanitized
    }
}

fn normalize_image_mime(requested: Option<&str>, detected: Option<&str>) -> Option<String> {
    for candidate in [detected, requested].into_iter().flatten() {
        let mime = candidate
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if image_extension_for_mime(&mime).is_some() {
            return Some(mime);
        }
    }
    None
}

fn image_extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn build_codex_learning_prompt(request: &serde_json::Value) -> String {
    let node = request.get("node").unwrap_or(&serde_json::Value::Null);
    let parent = request.get("parent").unwrap_or(&serde_json::Value::Null);
    let root = request.get("root").unwrap_or(&serde_json::Value::Null);
    let title = json_str(node, "title");
    let user_message = request
        .get("userMessage")
        .and_then(|value| value.as_str())
        .unwrap_or("请继续解释当前节点。");
    let recent_messages = request
        .get("recentMessages")
        .and_then(|value| value.as_array())
        .map(|messages| {
            messages
                .iter()
                .rev()
                .take(6)
                .rev()
                .map(|message| {
                    format!(
                        "- {}: {}",
                        json_str(message, "role"),
                        truncate(json_str(message, "content"), 700)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "- none".to_string());

    vec![
        "你是 OpenMindSteed 的中文学习导师。只回答学习问题，不要写代码、不要运行命令、不要编辑文件。".to_string(),
        String::new(),
        "回答要求：清晰、分层、适合沉淀到知识树；最后给出下一步可探索方向，但不要创建节点。".to_string(),
        "在回答末尾追加一个机器可读元数据块，不要放进 Markdown 代码块。格式必须是：".to_string(),
        format!(
            "{}{{\"title\":\"不超过 24 字\",\"summary\":\"不超过 180 字\",\"suggestions\":[{{\"label\":\"概念名\",\"reason\":\"为什么值得展开\",\"priority\":1,\"difficulty\":\"beginner\",\"relation\":\"child\"}}]}}{}",
            CODEX_METADATA_START, CODEX_METADATA_END
        ),
        format!(
            "对话意图: {}",
            request
                .get("intent")
                .and_then(|value| value.as_str())
                .unwrap_or("follow_up")
        ),
        format!("当前节点: {}", title),
        format!("当前节点摘要: {}", json_str(node, "summary")),
        format!("父节点: {}", json_str(parent, "title")),
        format!("父节点摘要: {}", json_str(parent, "summary")),
        format!("根节点: {}", json_str(root, "title")),
        format!("根节点摘要: {}", json_str(root, "summary")),
        format!(
            "来源文本: {}",
            request
                .get("sourceText")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        ),
        "最近消息:".to_string(),
        recent_messages,
        String::new(),
        format!("用户新问题: {}", user_message),
    ]
    .join("\n")
}

fn extract_codex_structured_response(answer: &str) -> (String, Option<CodexExtraction>) {
    let Some(start) = answer.rfind(CODEX_METADATA_START) else {
        return (answer.to_string(), None);
    };
    let metadata_start = start + CODEX_METADATA_START.len();
    let Some(relative_end) = answer[metadata_start..].find(CODEX_METADATA_END) else {
        return (answer.to_string(), None);
    };
    let metadata_end = metadata_start + relative_end;
    let after_end = metadata_end + CODEX_METADATA_END.len();
    let metadata_json = answer[metadata_start..metadata_end].trim();
    let Ok(metadata) = serde_json::from_str::<CodexMetadataBlock>(metadata_json) else {
        return (answer.to_string(), None);
    };

    let visible_answer = format!("{}{}", &answer[..start], &answer[after_end..])
        .trim()
        .to_string();
    match codex_extraction_from_metadata(metadata) {
        Some(extraction) => (visible_answer, Some(extraction)),
        None => (answer.to_string(), None),
    }
}

fn codex_extraction_from_metadata(metadata: CodexMetadataBlock) -> Option<CodexExtraction> {
    let title = truncate_non_empty(metadata.title.as_deref(), 48)?;
    let summary = truncate_non_empty(metadata.summary.as_deref(), 420)?;
    let suggestions = metadata
        .suggestions
        .unwrap_or_default()
        .into_iter()
        .filter_map(codex_suggestion_from_metadata)
        .take(5)
        .collect::<Vec<_>>();
    Some(CodexExtraction {
        title,
        summary,
        suggestions,
    })
}

fn codex_suggestion_from_metadata(suggestion: CodexMetadataSuggestion) -> Option<CodexSuggestion> {
    let label = truncate_non_empty(suggestion.label.as_deref(), 36)?;
    let difficulty = normalize_codex_difficulty(suggestion.difficulty.as_deref());
    Some(CodexSuggestion {
        label,
        reason: truncate_non_empty(suggestion.reason.as_deref(), 120)
            .unwrap_or_else(|| "这是当前回答里值得继续展开的概念。".to_string()),
        priority: suggestion.priority.unwrap_or(1).clamp(1, 5),
        difficulty,
        relation: truncate_non_empty(suggestion.relation.as_deref(), 24)
            .unwrap_or_else(|| "child".to_string()),
    })
}

fn normalize_codex_difficulty(value: Option<&str>) -> String {
    match value.unwrap_or("beginner").trim() {
        "beginner" | "intermediate" | "advanced" => value.unwrap_or("beginner").trim().to_string(),
        _ => "beginner".to_string(),
    }
}

fn truncate_non_empty(value: Option<&str>, limit: usize) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate(trimmed, limit))
    }
}

fn fallback_codex_extraction(request: &serde_json::Value, answer: &str) -> CodexExtraction {
    let user_message = request
        .get("userMessage")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let node_title = request
        .get("node")
        .and_then(|node| node.get("title"))
        .and_then(|value| value.as_str())
        .unwrap_or("继续探索");

    let mut labels = answer
        .split(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '，' | '。' | '！' | '？' | '、' | ':' | '：' | ';' | '；'
                )
        })
        .map(|token| {
            token.trim_matches(|character: char| {
                matches!(
                    character,
                    '"' | '\'' | '(' | ')' | '（' | '）' | '[' | ']' | '“' | '”'
                )
            })
        })
        .filter(|token| token.chars().count() >= 2 && token.chars().count() <= 18)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    labels.dedup();
    if labels.is_empty() {
        labels.push(if user_message.trim().is_empty() {
            node_title.to_string()
        } else {
            truncate(user_message, 18)
        });
    }

    CodexExtraction {
        title: truncate(
            if user_message.trim().is_empty() {
                node_title
            } else {
                user_message
            },
            22,
        ),
        summary: truncate(answer, 420),
        suggestions: labels
            .into_iter()
            .take(5)
            .enumerate()
            .map(|(index, label)| CodexSuggestion {
                label,
                reason: "这是当前回答里值得继续展开的概念。".to_string(),
                priority: (index + 1) as u8,
                difficulty: "beginner".to_string(),
                relation: "child".to_string(),
            })
            .collect(),
    }
}

fn json_str<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
}

fn truncate(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut result = trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    while result.chars().last().is_some_and(char::is_whitespace) {
        result.pop();
    }
    result.push('…');
    result
}

fn truncate_codex_diagnostic(value: &str, limit: usize) -> String {
    truncate(&value.replace(['\n', '\r', '\t'], " "), limit)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianSyncRequest {
    vault_path: String,
    package_payload: ObsidianPackage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianPackage {
    files: Vec<ObsidianFile>,
    #[serde(default)]
    assets: Vec<ObsidianAsset>,
    tree_count: usize,
    node_count: usize,
    scope: Option<ObsidianPackageScope>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianPackageScope {
    kind: String,
    root_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianFile {
    relative_path: String,
    contents: String,
    kind: String,
    source_id: String,
    root_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianAsset {
    relative_path: String,
    source_path: String,
    kind: String,
    source_id: String,
    root_id: String,
    mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianSyncResult {
    root_directory: String,
    files_written: usize,
    files_moved_to_deleted: usize,
    manifest_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifestEntry {
    kind: String,
    source_id: String,
    relative_path: String,
    status: String,
    #[serde(default)]
    root_id: Option<String>,
    #[serde(default)]
    deleted_path: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifest {
    #[serde(default)]
    entries: Vec<SyncManifestEntry>,
}

#[tauri::command]
fn sync_obsidian_vault(
    app: AppHandle,
    payload: ObsidianSyncRequest,
) -> Result<ObsidianSyncResult, String> {
    sync_obsidian_vault_impl(payload, Some(generated_images_dir(&app)?))
}

fn sync_obsidian_vault_impl(
    payload: ObsidianSyncRequest,
    allowed_asset_source_dir: Option<PathBuf>,
) -> Result<ObsidianSyncResult, String> {
    let root = PathBuf::from(payload.vault_path.trim());
    if root.as_os_str().is_empty() {
        return Err("Obsidian vault path is empty.".to_string());
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let manifest_path = root.join(".mindsteed-sync.json");
    let previous_entries = read_sync_manifest_entries(&manifest_path)?;

    let mut files_written = 0;
    for file in &payload.package_payload.files {
        let target = safe_join(&root, &file.relative_path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let existing = fs::read_to_string(&target).ok();
        let merged = merge_managed_document(&file.contents, existing.as_deref());
        if existing.as_deref() != Some(merged.as_str()) {
            fs::write(&target, merged).map_err(|error| error.to_string())?;
            files_written += 1;
        }
    }

    let allowed_asset_source_dir = allowed_asset_source_dir.unwrap_or_else(|| {
        payload
            .package_payload
            .assets
            .first()
            .and_then(|asset| {
                Path::new(&asset.source_path)
                    .parent()
                    .map(Path::to_path_buf)
            })
            .unwrap_or_else(std::env::temp_dir)
    });
    if !payload.package_payload.assets.is_empty() {
        fs::create_dir_all(&allowed_asset_source_dir).map_err(|error| error.to_string())?;
    }
    for asset in &payload.package_payload.assets {
        if copy_obsidian_asset(&root, &allowed_asset_source_dir, asset)? {
            files_written += 1;
        }
    }

    let active_paths = payload
        .package_payload
        .files
        .iter()
        .map(|file| file.relative_path.clone())
        .chain(
            payload
                .package_payload
                .assets
                .iter()
                .map(|asset| asset.relative_path.clone()),
        )
        .collect::<HashSet<_>>();
    let mut entries = payload
        .package_payload
        .files
        .iter()
        .map(|file| SyncManifestEntry {
            kind: file.kind.clone(),
            source_id: file.source_id.clone(),
            relative_path: file.relative_path.clone(),
            status: "active".to_string(),
            root_id: file.root_id.clone(),
            deleted_path: None,
            deleted_at: None,
        })
        .chain(
            payload
                .package_payload
                .assets
                .iter()
                .map(|asset| SyncManifestEntry {
                    kind: asset.kind.clone(),
                    source_id: asset.source_id.clone(),
                    relative_path: asset.relative_path.clone(),
                    status: "active".to_string(),
                    root_id: Some(asset.root_id.clone()),
                    deleted_path: None,
                    deleted_at: None,
                }),
        )
        .collect::<Vec<_>>();
    let scope = payload
        .package_payload
        .scope
        .as_ref()
        .map(|scope| SyncPruneScope {
            kind: scope.kind.as_str(),
            root_id: scope.root_id.as_deref(),
        })
        .unwrap_or(SyncPruneScope {
            kind: "vault",
            root_id: None,
        });
    let deleted_at = current_sync_timestamp();
    let deleted_batch = deleted_batch_name();
    let mut files_moved_to_deleted = 0;

    for entry in previous_entries {
        if entry.status == "deleted" {
            entries.push(entry);
            continue;
        }
        if active_paths.contains(&entry.relative_path) {
            continue;
        }
        if should_prune_manifest_entry(&entry, &scope) {
            let mut deleted_entry = entry.clone();
            deleted_entry.status = "deleted".to_string();
            deleted_entry.deleted_at = Some(deleted_at.clone());
            if let Some(deleted_path) =
                move_previous_sync_file_to_deleted(&root, &entry, &deleted_batch)?
            {
                deleted_entry.deleted_path = Some(deleted_path);
                files_moved_to_deleted += 1;
            }
            entries.push(deleted_entry);
        } else {
            entries.push(entry);
        }
    }

    let manifest = serde_json::json!({
        "version": 1,
        "lastSyncedAt": deleted_at,
        "treeCount": payload.package_payload.tree_count,
        "nodeCount": payload.package_payload.node_count,
        "scope": &payload.package_payload.scope,
        "entries": entries
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    Ok(ObsidianSyncResult {
        root_directory: root.to_string_lossy().to_string(),
        files_written,
        files_moved_to_deleted,
        manifest_path: manifest_path.to_string_lossy().to_string(),
    })
}

struct SyncPruneScope<'a> {
    kind: &'a str,
    root_id: Option<&'a str>,
}

fn copy_obsidian_asset(
    root: &Path,
    allowed_source_dir: &Path,
    asset: &ObsidianAsset,
) -> Result<bool, String> {
    let target = safe_join(root, &asset.relative_path)?;
    let source = PathBuf::from(asset.source_path.trim());
    if !source.is_absolute() {
        return Err(format!(
            "Generated image asset source must be an absolute path: {}",
            asset.source_path
        ));
    }
    let allowed_source_dir = fs::canonicalize(allowed_source_dir).map_err(|error| {
        format!(
            "Could not resolve generated image asset directory: {}",
            error
        )
    })?;
    let source = fs::canonicalize(&source)
        .map_err(|error| format!("Could not resolve generated image asset source: {}", error))?;
    if !source.starts_with(&allowed_source_dir) {
        return Err(format!(
            "Refusing to copy generated image outside OpenMindSteed asset storage: {}",
            asset.source_path
        ));
    }
    if !source.is_file() {
        return Err(format!(
            "Generated image asset source is not a file: {}",
            asset.source_path
        ));
    }
    if image_extension_for_mime(&asset.mime_type).is_none() {
        return Err(format!(
            "Generated image asset has unsupported MIME type: {}",
            asset.mime_type
        ));
    }
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    if fs::read(&target).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

fn read_sync_manifest_entries(path: &Path) -> Result<Vec<SyncManifestEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let manifest = serde_json::from_str::<SyncManifest>(&raw).unwrap_or(SyncManifest {
        entries: Vec::new(),
    });
    Ok(manifest.entries)
}

fn should_prune_manifest_entry(entry: &SyncManifestEntry, scope: &SyncPruneScope<'_>) -> bool {
    if scope.kind == "tree" {
        return entry.root_id.as_deref() == scope.root_id;
    }
    true
}

fn move_previous_sync_file_to_deleted(
    root: &Path,
    entry: &SyncManifestEntry,
    batch: &str,
) -> Result<Option<String>, String> {
    let source = match safe_join(root, &entry.relative_path) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !source.is_file() {
        return Ok(None);
    }

    let preferred_relative_path = format!("_Deleted/{}/{}", batch, entry.relative_path);
    let (deleted_relative_path, destination) =
        unique_deleted_target(root, &preferred_relative_path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(&source, &destination).map_err(|error| error.to_string())?;
    Ok(Some(deleted_relative_path))
}

fn unique_deleted_target(
    root: &Path,
    preferred_relative_path: &str,
) -> Result<(String, PathBuf), String> {
    for attempt in 0..1000 {
        let candidate = if attempt == 0 {
            preferred_relative_path.to_string()
        } else {
            add_relative_path_suffix(preferred_relative_path, attempt)
        };
        let target = safe_join(root, &candidate)?;
        if !target.exists() {
            return Ok((candidate, target));
        }
    }
    Err(format!(
        "Could not find a unique deleted-file path for {}",
        preferred_relative_path
    ))
}

fn add_relative_path_suffix(relative_path: &str, attempt: usize) -> String {
    let path = Path::new(relative_path);
    let parent = path.parent().filter(|value| !value.as_os_str().is_empty());
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("deleted");
    let extension = path.extension().and_then(|value| value.to_str());
    let filename = match extension {
        Some(extension) if !extension.is_empty() => format!("{}-{}.{}", stem, attempt, extension),
        _ => format!("{}-{}", stem, attempt),
    };
    match parent {
        Some(parent) => parent.join(filename).to_string_lossy().replace('\\', "/"),
        None => filename,
    }
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let connection = open_state_db(&app)?;
    load_state_from_db(&connection)
}

#[tauri::command]
fn save_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let connection = open_state_db(&app)?;
    save_state_to_db(&connection, &state)
}

fn load_state_from_db(connection: &Connection) -> Result<Option<serde_json::Value>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![STATE_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    value
        .map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .transpose()
}

fn save_state_to_db(connection: &Connection, state: &serde_json::Value) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO app_state (key, value, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![STATE_KEY, state.to_string()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_secret(key: String) -> Result<String, String> {
    let account = safe_secret_key(&key);
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_secret(key: String, value: String) -> Result<(), String> {
    let account = safe_secret_key(&key);
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
        .map_err(|error| error.to_string())?;
    entry
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    let account = safe_secret_key(&key);
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
        .map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn safe_secret_key(key: &str) -> String {
    let sanitized = key
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

fn open_state_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    open_state_db_at(&dir)
}

fn open_state_db_at(dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let connection =
        Connection::open(dir.join("openmindsteed.sqlite")).map_err(|error| error.to_string())?;
    apply_state_migrations(&connection)?;
    Ok(connection)
}

fn apply_state_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
             VALUES (?1, ?2, datetime('now'))",
            params![STATE_SCHEMA_VERSION, "app_state_json_store_v1"],
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute_batch(&format!("PRAGMA user_version = {};", STATE_SCHEMA_VERSION))
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err(format!("Refusing absolute sync path: {}", relative_path));
    }
    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("Refusing unsafe sync path: {}", relative_path)),
        }
    }
    Ok(root.join(relative))
}

fn merge_managed_document(generated_managed: &str, existing: Option<&str>) -> String {
    const START: &str = "<!-- mindsteed:managed:start -->";
    const END: &str = "<!-- mindsteed:managed:end -->";

    let generated = generated_managed.trim();
    let Some(existing) = existing else {
        return format!("{}\n\n## My Notes\n\n", generated);
    };
    if existing.trim().is_empty() {
        return format!("{}\n\n## My Notes\n\n", generated);
    }
    let Some(start) = existing.find(START) else {
        return format!("{}\n\n## My Notes\n\n{}\n", generated, existing.trim());
    };
    let Some(end_start) = existing[start + START.len()..].find(END) else {
        return format!("{}\n\n## My Notes\n\n{}\n", generated, existing.trim());
    };
    let end = start + START.len() + end_start + END.len();
    format!("{}{}{}", &existing[..start], generated, &existing[end..])
}

fn current_sync_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{}", seconds)
}

fn deleted_batch_name() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix-{}", seconds)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            store_generated_image_asset,
            codex_local_turn,
            codex_local_cancel,
            codex_status,
            sync_obsidian_vault,
            load_state,
            save_state,
            load_secret,
            save_secret,
            delete_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenMindSteed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("openmindsteed-{}-{}", name, suffix))
    }

    fn obsidian_file(relative_path: &str, source_id: &str, root_id: &str) -> ObsidianFile {
        ObsidianFile {
            relative_path: relative_path.to_string(),
            contents: "<!-- mindsteed:managed:start -->\nnew\n<!-- mindsteed:managed:end -->"
                .to_string(),
            kind: "node".to_string(),
            source_id: source_id.to_string(),
            root_id: Some(root_id.to_string()),
        }
    }

    fn package(
        files: Vec<ObsidianFile>,
        scope: ObsidianPackageScope,
        tree_count: usize,
        node_count: usize,
    ) -> ObsidianPackage {
        ObsidianPackage {
            files,
            assets: Vec::new(),
            tree_count,
            node_count,
            scope: Some(scope),
        }
    }

    fn scope(kind: &str, root_id: Option<&str>) -> ObsidianPackageScope {
        ObsidianPackageScope {
            kind: kind.to_string(),
            root_id: root_id.map(ToString::to_string),
        }
    }

    fn write_previous_manifest(root: &Path, entries: Vec<SyncManifestEntry>) {
        fs::create_dir_all(root).expect("create temp vault");
        let manifest = serde_json::json!({
            "version": 1,
            "lastSyncedAt": "unix:1",
            "entries": entries
        });
        fs::write(
            root.join(".mindsteed-sync.json"),
            serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");
    }

    fn write_old_file(root: &Path, relative_path: &str) {
        let target = safe_join(root, relative_path).expect("safe test path");
        fs::create_dir_all(target.parent().expect("test parent")).expect("create old parent");
        fs::write(target, "old generated\n\n## My Notes\n\nkeep").expect("write old file");
    }

    fn active_entry(relative_path: &str, source_id: &str, root_id: &str) -> SyncManifestEntry {
        SyncManifestEntry {
            kind: "node".to_string(),
            source_id: source_id.to_string(),
            relative_path: relative_path.to_string(),
            status: "active".to_string(),
            root_id: Some(root_id.to_string()),
            deleted_path: None,
            deleted_at: None,
        }
    }

    fn obsidian_asset(
        relative_path: &str,
        source_path: &Path,
        source_id: &str,
        root_id: &str,
    ) -> ObsidianAsset {
        ObsidianAsset {
            relative_path: relative_path.to_string(),
            source_path: source_path.to_string_lossy().to_string(),
            kind: "generatedImage".to_string(),
            source_id: source_id.to_string(),
            root_id: root_id.to_string(),
            mime_type: "image/png".to_string(),
        }
    }

    #[test]
    fn sqlite_state_store_round_trips_and_overwrites_state() {
        let dir = temp_vault("state-db");
        let connection = open_state_db_at(&dir).expect("open state db");

        assert!(dir.join("openmindsteed.sqlite").exists());
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version");
        let migration_name: String = connection
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = ?1",
                rusqlite::params![STATE_SCHEMA_VERSION],
                |row| row.get(0),
            )
            .expect("read migration record");

        assert_eq!(schema_version, STATE_SCHEMA_VERSION);
        assert_eq!(migration_name, "app_state_json_store_v1");
        assert_eq!(load_state_from_db(&connection).expect("empty load"), None);

        let first = serde_json::json!({
            "selectedNodeId": "node-a",
            "nodes": [{"id": "node-a", "title": "First"}],
            "settings": {"provider": {"apiKey": ""}}
        });
        save_state_to_db(&connection, &first).expect("save first state");

        assert_eq!(
            load_state_from_db(&connection).expect("load first state"),
            Some(first)
        );

        let second = serde_json::json!({
            "selectedNodeId": "node-b",
            "nodes": [{"id": "node-b", "title": "Second"}],
            "settings": {"provider": {"apiKey": ""}}
        });
        save_state_to_db(&connection, &second).expect("overwrite state");

        let stored_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_state WHERE key = ?1",
                rusqlite::params![STATE_KEY],
                |row| row.get(0),
            )
            .expect("count stored state rows");

        assert_eq!(
            load_state_from_db(&connection).expect("load overwritten state"),
            Some(second)
        );
        assert_eq!(stored_count, 1);

        drop(connection);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn full_sync_moves_missing_manifest_files_to_deleted() {
        let root = temp_vault("full-prune");
        let old_path = "Trees/Root/Nodes/Old.md";
        write_old_file(&root, old_path);
        write_previous_manifest(&root, vec![active_entry(old_path, "node-old", "root-a")]);

        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: package(
                vec![obsidian_file(
                    "Trees/Root/Nodes/New.md",
                    "node-new",
                    "root-a",
                )],
                scope("vault", None),
                1,
                1,
            ),
        };

        let result = sync_obsidian_vault_impl(request, None).expect("sync vault");
        let entries = read_sync_manifest_entries(&root.join(".mindsteed-sync.json"))
            .expect("read written manifest");
        let deleted = entries
            .iter()
            .find(|entry| entry.source_id == "node-old")
            .expect("deleted manifest entry");
        let deleted_path = deleted.deleted_path.as_deref().expect("deleted path");

        assert_eq!(result.files_moved_to_deleted, 1);
        assert_eq!(deleted.status, "deleted");
        assert!(!safe_join(&root, old_path).expect("old path").exists());
        assert!(safe_join(&root, deleted_path)
            .expect("deleted path")
            .exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn selected_tree_sync_prunes_only_matching_root_entries() {
        let root = temp_vault("tree-prune");
        let old_a = "Trees/A/Nodes/Old A.md";
        let old_b = "Trees/B/Nodes/Old B.md";
        write_old_file(&root, old_a);
        write_old_file(&root, old_b);
        write_previous_manifest(
            &root,
            vec![
                active_entry(old_a, "node-old-a", "root-a"),
                active_entry(old_b, "node-old-b", "root-b"),
            ],
        );

        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: package(
                vec![obsidian_file(
                    "Trees/A/Nodes/New A.md",
                    "node-new-a",
                    "root-a",
                )],
                scope("tree", Some("root-a")),
                1,
                1,
            ),
        };

        let result = sync_obsidian_vault_impl(request, None).expect("sync selected tree");
        let entries = read_sync_manifest_entries(&root.join(".mindsteed-sync.json"))
            .expect("read written manifest");
        let deleted_a = entries
            .iter()
            .find(|entry| entry.source_id == "node-old-a")
            .expect("deleted root-a entry");
        let kept_b = entries
            .iter()
            .find(|entry| entry.source_id == "node-old-b")
            .expect("kept root-b entry");

        assert_eq!(result.files_moved_to_deleted, 1);
        assert_eq!(deleted_a.status, "deleted");
        assert_eq!(kept_b.status, "active");
        assert!(!safe_join(&root, old_a).expect("old a").exists());
        assert!(safe_join(&root, old_b).expect("old b").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_replaces_managed_block_and_preserves_manual_notes() {
        let root = temp_vault("preserve-notes");
        let relative_path = "Trees/A/Nodes/Node.md";
        let target = safe_join(&root, relative_path).expect("node path");
        fs::create_dir_all(target.parent().expect("node parent")).expect("create node parent");
        fs::write(
            &target,
            "<!-- mindsteed:managed:start -->\nold generated\n<!-- mindsteed:managed:end -->\n\n## My Notes\n\nmanual note\n\n## Extra\n\nkeep me",
        )
        .expect("write existing note");

        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: package(
                vec![obsidian_file(relative_path, "node-a", "root-a")],
                scope("tree", Some("root-a")),
                1,
                1,
            ),
        };

        let result = sync_obsidian_vault_impl(request, None).expect("sync existing note");
        let contents = fs::read_to_string(&target).expect("read merged note");

        assert_eq!(result.files_written, 1);
        assert!(contents
            .contains("<!-- mindsteed:managed:start -->\nnew\n<!-- mindsteed:managed:end -->"));
        assert!(!contents.contains("old generated"));
        assert!(contents.contains("## My Notes\n\nmanual note"));
        assert!(contents.contains("## Extra\n\nkeep me"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_rejects_unsafe_markdown_paths() {
        let root = temp_vault("unsafe-markdown-path");
        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: package(
                vec![obsidian_file("../outside.md", "node-a", "root-a")],
                scope("tree", Some("root-a")),
                1,
                1,
            ),
        };

        let error = sync_obsidian_vault_impl(request, None).expect_err("reject unsafe path");

        assert!(error.contains("Refusing unsafe sync path"));
        assert!(!root.join("../outside.md").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_rejects_unsafe_generated_image_target_paths() {
        let root = temp_vault("unsafe-asset-path");
        let source_dir = temp_vault("asset-source-safe");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let source_path = source_dir.join("img-a.png");
        fs::write(&source_path, b"png bytes").expect("write source asset");

        let mut pkg = package(Vec::new(), scope("tree", Some("root-a")), 1, 0);
        pkg.assets.push(obsidian_asset(
            "../Assets/img-a.png",
            &source_path,
            "img-a",
            "root-a",
        ));
        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: pkg,
        };

        let error = sync_obsidian_vault_impl(request, Some(source_dir.clone()))
            .expect_err("reject unsafe asset target");

        assert!(error.contains("Refusing unsafe sync path"));
        assert!(!root.join("../Assets/img-a.png").exists());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(source_dir);
    }

    #[test]
    fn sync_copies_generated_image_assets_into_vault_and_manifest() {
        let root = temp_vault("asset-copy");
        let source_dir = temp_vault("asset-source");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let source_path = source_dir.join("img-a.png");
        fs::write(&source_path, b"png bytes").expect("write source asset");

        let mut pkg = package(
            vec![obsidian_file("Trees/A/Nodes/Node.md", "node-a", "root-a")],
            scope("tree", Some("root-a")),
            1,
            1,
        );
        pkg.assets.push(obsidian_asset(
            "Trees/A/Assets/img-a.png",
            &source_path,
            "img-a",
            "root-a",
        ));

        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: pkg,
        };

        let result =
            sync_obsidian_vault_impl(request, Some(source_dir.clone())).expect("sync with asset");
        let copied = safe_join(&root, "Trees/A/Assets/img-a.png").expect("asset path");
        let entries = read_sync_manifest_entries(&root.join(".mindsteed-sync.json"))
            .expect("read written manifest");

        assert_eq!(result.files_written, 2);
        assert_eq!(fs::read(copied).expect("read copied asset"), b"png bytes");
        assert!(entries.iter().any(|entry| {
            entry.kind == "generatedImage"
                && entry.source_id == "img-a"
                && entry.relative_path == "Trees/A/Assets/img-a.png"
                && entry.status == "active"
        }));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(source_dir);
    }

    #[test]
    fn sync_rejects_generated_image_assets_outside_allowed_source_dir() {
        let root = temp_vault("asset-reject");
        let source_dir = temp_vault("asset-source-allowed");
        let outside_dir = temp_vault("asset-source-outside");
        fs::create_dir_all(&source_dir).expect("create source dir");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        let outside_path = outside_dir.join("secret.png");
        fs::write(&outside_path, b"not allowed").expect("write outside asset");

        let mut pkg = package(
            vec![obsidian_file("Trees/A/Nodes/Node.md", "node-a", "root-a")],
            scope("tree", Some("root-a")),
            1,
            1,
        );
        pkg.assets.push(obsidian_asset(
            "Trees/A/Assets/secret.png",
            &outside_path,
            "img-secret",
            "root-a",
        ));

        let request = ObsidianSyncRequest {
            vault_path: root.to_string_lossy().to_string(),
            package_payload: pkg,
        };

        let error = sync_obsidian_vault_impl(request, Some(source_dir.clone()))
            .expect_err("reject outside source");

        assert!(error.contains("outside OpenMindSteed asset storage"));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(outside_dir);
    }

    #[test]
    fn codex_cancel_registry_marks_and_clears_request_ids() {
        let request_id = format!("test-cancel-{}", deleted_batch_name());

        assert!(!is_codex_cancelled(&request_id));
        mark_codex_cancelled(&request_id).expect("mark cancelled");
        assert!(is_codex_cancelled(&request_id));
        assert_eq!(
            ensure_codex_not_cancelled(&request_id).expect_err("cancelled error"),
            "Codex request cancelled."
        );
        clear_codex_cancel(&request_id);
        assert!(!is_codex_cancelled(&request_id));
    }

    #[test]
    fn codex_diagnostic_truncation_keeps_resume_errors_single_line() {
        let diagnostic = truncate_codex_diagnostic("line one\nline two\tline three", 18);

        assert!(!diagnostic.contains('\n'));
        assert!(!diagnostic.contains('\t'));
        assert_eq!(diagnostic, "line one line two…");
    }

    #[test]
    fn codex_missing_binary_error_includes_setup_actions() {
        let error = codex_missing_binary_error("bad path\npermission denied");

        assert!(error.contains("Install Codex"));
        assert!(error.contains("OPENMINDSTEED_CODEX_BIN"));
        assert!(error.contains("Settings"));
        assert!(!error.contains('\n'));
        assert!(error.contains("bad path permission denied"));
    }

    #[test]
    fn codex_cli_compatibility_marks_tested_range() {
        let compatible = codex_cli_compatibility("codex-cli 0.142.0");
        let newer = codex_cli_compatibility("codex-cli 0.143.0");
        let unknown = codex_cli_compatibility("codex-cli unknown");

        assert!(compatible.0);
        assert!(!newer.0);
        assert!(!unknown.0);
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.142.0"),
            Some((0, 142, 0))
        );
    }

    #[test]
    fn generated_image_asset_helpers_reject_unsafe_inputs() {
        assert!(parse_generated_image_source_url("https://example.com/image.png").is_ok());
        assert!(parse_generated_image_source_url("file:///tmp/image.png").is_err());
        assert_eq!(safe_generated_image_id("../bad id!"), "badid");
        assert_eq!(
            normalize_image_mime(Some("image/png"), Some("image/webp; charset=utf-8")),
            Some("image/webp".to_string())
        );
        assert_eq!(image_extension_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension_for_mime("text/html"), None);
    }

    #[test]
    fn completed_agent_message_text_is_extracted_from_item_payloads() {
        let message = serde_json::json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "agent_message",
                    "content": [
                        { "type": "output_text", "text": "第一段" },
                        { "type": "output_text", "text": "第二段" }
                    ]
                }
            }
        });

        assert_eq!(
            extract_completed_agent_message_text(&message).as_deref(),
            Some("第一段\n第二段")
        );
    }

    #[test]
    fn completed_non_agent_items_are_ignored() {
        let message = serde_json::json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "command_output",
                    "content": "do not show command output as tutor text"
                }
            }
        });

        assert!(extract_completed_agent_message_text(&message).is_none());
    }

    #[test]
    fn completed_agent_text_reconciles_with_streamed_delta() {
        let mut answer = "第一".to_string();

        let delta =
            reconcile_completed_agent_text(&mut answer, "第一段完整回答").expect("suffix delta");

        assert_eq!(delta, "段完整回答");
        assert_eq!(answer, "第一段完整回答");
        assert!(reconcile_completed_agent_text(&mut answer, "第一段完整回答").is_none());
    }

    #[test]
    fn codex_structured_metadata_is_parsed_and_removed_from_answer() {
        let answer = format!(
            "这是给用户看的回答。\n{}{{\"title\":\"结构化抽取\",\"summary\":\"摘要来自元数据。\",\"suggestions\":[{{\"label\":\"后续概念\",\"reason\":\"继续展开原因\",\"priority\":3,\"difficulty\":\"advanced\",\"relation\":\"child\"}}]}}{}",
            CODEX_METADATA_START, CODEX_METADATA_END
        );

        let (visible, extraction) = extract_codex_structured_response(&answer);
        let extraction = extraction.expect("metadata extraction");

        assert_eq!(visible, "这是给用户看的回答。");
        assert_eq!(extraction.title, "结构化抽取");
        assert_eq!(extraction.summary, "摘要来自元数据。");
        assert_eq!(extraction.suggestions.len(), 1);
        assert_eq!(extraction.suggestions[0].label, "后续概念");
        assert_eq!(extraction.suggestions[0].priority, 3);
        assert_eq!(extraction.suggestions[0].difficulty, "advanced");
    }

    #[test]
    fn codex_structured_metadata_falls_back_when_malformed() {
        let answer = format!(
            "回答正文\n{}{{bad json}}{}",
            CODEX_METADATA_START, CODEX_METADATA_END
        );

        let (visible, extraction) = extract_codex_structured_response(&answer);

        assert_eq!(visible, answer);
        assert!(extraction.is_none());
    }

    #[test]
    fn reportable_codex_item_events_emit_status_metadata() {
        let message = serde_json::json!({
            "method": "item/started",
            "params": {
                "item": {
                    "type": "command_execution",
                    "command": "ls -la"
                }
            }
        });

        let status = extract_codex_status_event(&message, "started").expect("status metadata");

        assert_eq!(status.status, "started");
        assert_eq!(status.kind, "command_execution");
        assert_eq!(status.label, "ls -la");
        assert_eq!(status.severity, "info");
    }

    #[test]
    fn blocked_codex_tool_work_events_use_warning_metadata() {
        let message = serde_json::json!({
            "method": "item/started",
            "params": {
                "item": {
                    "type": "command_execution",
                    "command": "ls -la"
                }
            }
        });

        let status = blocked_codex_tool_work_event(&message).expect("blocked metadata");

        assert_eq!(status.status, "blocked");
        assert_eq!(status.kind, "command_execution");
        assert_eq!(status.label, "ls -la");
        assert_eq!(status.severity, "warning");
        assert_eq!(
            codex_blocked_tool_work_error(&status),
            "Codex Local tried to perform command execution (ls -la) during a learning-only turn. The turn was stopped to avoid local tool or command work."
        );
    }

    #[test]
    fn agent_message_events_do_not_emit_status_metadata() {
        let message = serde_json::json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "agent_message",
                    "content": "visible tutor text"
                }
            }
        });

        assert!(extract_codex_status_event(&message, "completed").is_none());
    }
}
