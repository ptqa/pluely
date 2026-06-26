// Pluely AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{AudioDevice, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{error, warn};
use webrtc_audio_processing::config::{EchoCanceller, HighPassFilter, NoiseSuppression};
use webrtc_audio_processing::{Config, Processor};

const LIVE_AEC_SAMPLE_RATE: u32 = 48_000;
const LIVE_AUDIO_CHANNEL_CAPACITY: usize = 48_000 * 4;
const LIVE_RAW_MIC_CHANNEL_CAPACITY: usize = 256;
const LIVE_AEC_RENDER_CHANNEL_CAPACITY: usize = 256;
const LIVE_AEC_STREAM_DELAY_MS: u16 = 45;
const LIVE_AEC_RENDER_QUEUE_TARGET_FRAMES: usize = 1;
const LIVE_AEC_RENDER_HISTORY_FRAMES: usize = 24;
const LIVE_AEC_RENDER_ACTIVE_RMS: f32 = 0.004;
const LIVE_AEC_RENDER_ACTIVE_PEAK: f32 = 0.012;
const LIVE_AEC_RESIDUAL_ECHO_RMS_RATIO: f32 = 0.65;
const LIVE_AEC_RESIDUAL_ECHO_PEAK_RATIO: f32 = 0.75;
const LIVE_AEC_CORRELATED_ECHO_RMS_RATIO: f32 = 1.25;
const LIVE_AEC_CORRELATED_ECHO_PEAK_RATIO: f32 = 1.35;
const LIVE_AEC_ECHO_CORRELATION_THRESHOLD: f32 = 0.72;
const LIVE_AEC_FILTERED_ECHO_RMS_RATIO: f32 = 1.05;
const LIVE_AEC_FILTERED_ECHO_PEAK_RATIO: f32 = 1.20;
const LIVE_AEC_ECHO_ENVELOPE_CORRELATION_THRESHOLD: f32 = 0.76;
const LIVE_AEC_LOCAL_SPEECH_RMS_FLOOR: f32 = 0.018;
const LIVE_AEC_LOCAL_SPEECH_PEAK_FLOOR: f32 = 0.080;

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SystemAudioDiagnostic {
    event: &'static str,
    sample_rate: u32,
    rms: f32,
    peak: f32,
    speech_chunks: usize,
    silence_chunks: usize,
    buffered_samples: usize,
    message: String,
}

#[derive(Debug, Clone, Copy)]
enum LiveSpeaker {
    You,
    Them,
}

impl LiveSpeaker {
    fn as_str(self) -> &'static str {
        match self {
            Self::You => "you",
            Self::Them => "them",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum SpeechTarget {
    Legacy,
    Live(LiveSpeaker),
}

#[derive(Debug, Clone, Serialize)]
struct LiveSpeechDetected {
    speaker: &'static str,
    audio: String,
}

#[derive(Debug, Clone, Serialize)]
struct LiveAudioActivity {
    speaker: &'static str,
    active: bool,
}

pub(crate) struct LiveCaptureHandle {
    stop_tx: std::sync::mpsc::Sender<()>,
    mic_thread: Option<std::thread::JoinHandle<()>>,
    aec_task: tokio::task::JoinHandle<()>,
    render_task: tokio::task::JoinHandle<()>,
    you_vad_task: tokio::task::JoinHandle<()>,
    them_vad_task: tokio::task::JoinHandle<()>,
}

impl LiveCaptureHandle {
    fn stop(mut self) {
        let _ = self.stop_tx.send(());
        self.aec_task.abort();
        self.render_task.abort();
        self.you_vad_task.abort();
        self.them_vad_task.abort();

        if let Some(thread) = self.mic_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 45,     // ~1.0s of silence before stopping
            min_speech_chunks: 7,   // ~0.16s - captures short answers
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

fn emit_speech_detected(app: &AppHandle, target: SpeechTarget, b64: String) {
    match target {
        SpeechTarget::Legacy => {
            let _ = app.emit("speech-detected", b64);
        }
        SpeechTarget::Live(speaker) => {
            let _ = app.emit(
                "live-speech-detected",
                LiveSpeechDetected {
                    speaker: speaker.as_str(),
                    audio: b64,
                },
            );
        }
    }
}

fn emit_audio_activity(app: &AppHandle, target: SpeechTarget, active: bool) {
    match target {
        SpeechTarget::Legacy => {
            let _ = app.emit("system-audio-activity", active);
        }
        SpeechTarget::Live(speaker) => {
            let _ = app.emit(
                "live-audio-activity",
                LiveAudioActivity {
                    speaker: speaker.as_str(),
                    active,
                },
            );
        }
    }
}

fn emit_speech_start(app: &AppHandle, target: SpeechTarget) {
    match target {
        SpeechTarget::Legacy => {
            let _ = app.emit("speech-start", ());
        }
        SpeechTarget::Live(speaker) => {
            let _ = app.emit("live-speech-start", speaker.as_str());
        }
    }
}

fn should_zero_silent_vad_chunks(target: SpeechTarget) -> bool {
    matches!(target, SpeechTarget::Live(LiveSpeaker::You))
}

fn trailing_silence_to_keep_samples(target: SpeechTarget, sample_rate: u32) -> usize {
    if should_zero_silent_vad_chunks(target) {
        return 0;
    }

    sample_rate as usize * 15 / 100
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Check if already capturing (atomic check)
    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        if guard.is_some() {
            warn!("Capture already running");
            return Err("Capture already running".to_string());
        }
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    let device_label = device_id.clone().unwrap_or_else(|| "default".to_string());
    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    // Mark as capturing BEFORE spawning task
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;

    // Emit capture started event
    let _ = app_clone.emit("capture-started", sr);
    let _ = app_clone.emit("system-audio-activity", false);
    let _ = app_clone.emit(
        "system-audio-diagnostic",
        SystemAudioDiagnostic {
            event: "capture-started",
            sample_rate: sr,
            rms: 0.0,
            peak: 0.0,
            speech_chunks: 0,
            silence_chunks: 0,
            buffered_samples: 0,
            message: format!(
                "device={}, vad enabled, rms>{:.4}, peak>{:.4}, min_chunks={}, silence_chunks={}",
                device_label,
                vad_config.sensitivity_rms,
                vad_config.peak_threshold,
                vad_config.min_speech_chunks,
                vad_config.silence_chunks
            ),
        },
    );

    let state_clone = app.state::<crate::AudioState>();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                SpeechTarget::Legacy,
            )
            .await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config).await;
        }

        let state = app_clone.state::<crate::AudioState>();
        {
            if let Ok(mut guard) = state.stream_task.lock() {
                *guard = None;
            };
        }
    });

    *state_clone
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    target: SpeechTarget,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance
    let mut last_level_diagnostic = Instant::now();
    let mut max_rms_since_diagnostic = 0.0f32;
    let mut max_peak_since_diagnostic = 0.0f32;
    let mut chunks_since_diagnostic = 0usize;

    while let Some(sample) = stream.next().await {
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Apply noise gate BEFORE VAD (critical for accuracy)
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);

            let (rms, peak) = calculate_audio_metrics(&mono);
            let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;
            max_rms_since_diagnostic = max_rms_since_diagnostic.max(rms);
            max_peak_since_diagnostic = max_peak_since_diagnostic.max(peak);
            chunks_since_diagnostic += 1;

            if last_level_diagnostic.elapsed() >= Duration::from_secs(1) {
                let _ = app.emit(
                    "system-audio-diagnostic",
                    SystemAudioDiagnostic {
                        event: "levels",
                        sample_rate: sr,
                        rms: max_rms_since_diagnostic,
                        peak: max_peak_since_diagnostic,
                        speech_chunks,
                        silence_chunks,
                        buffered_samples: speech_buffer.len(),
                        message: format!(
                            "chunks={}, in_speech={}, thresholds rms>{:.4} peak>{:.4}",
                            chunks_since_diagnostic,
                            in_speech,
                            config.sensitivity_rms,
                            config.peak_threshold
                        ),
                    },
                );
                last_level_diagnostic = Instant::now();
                max_rms_since_diagnostic = 0.0;
                max_peak_since_diagnostic = 0.0;
                chunks_since_diagnostic = 0;
            }

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    emit_speech_start(&app, target);
                    emit_audio_activity(&app, target, true);
                    let _ = app.emit(
                        "system-audio-diagnostic",
                        SystemAudioDiagnostic {
                            event: "speech-start",
                            sample_rate: sr,
                            rms,
                            peak,
                            speech_chunks,
                            silence_chunks,
                            buffered_samples: speech_buffer.len(),
                            message: "VAD crossed speech threshold".to_string(),
                        },
                    );
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                        // let duration = speech_buffer.len() as f32 / sr as f32;
                        emit_speech_detected(&app, target, b64);
                        let _ = app.emit(
                            "system-audio-diagnostic",
                            SystemAudioDiagnostic {
                                event: "speech-detected",
                                sample_rate: sr,
                                rms,
                                peak,
                                speech_chunks,
                                silence_chunks,
                                buffered_samples: speech_buffer.len(),
                                message: "Forced emit at safety cap".to_string(),
                            },
                        );
                    }
                    emit_audio_activity(&app, target, false);
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks += 1;

                    // Do not let sub-threshold echo/noise ride along in a You segment and get
                    // amplified by normalization before STT.
                    if should_zero_silent_vad_chunks(target) {
                        speech_buffer.resize(speech_buffer.len() + mono.len(), 0.0);
                    } else {
                        speech_buffer.extend_from_slice(&mono);
                    }

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= config.silence_chunks {
                        // Verify minimum speech duration
                        if speech_chunks >= config.min_speech_chunks && !speech_buffer.is_empty() {
                            // Trim trailing silence. You segments keep no artificial tail because
                            // Whisper-style STT commonly hallucinates multilingual closing phrases
                            // from otherwise empty mic audio.
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = trailing_silence_to_keep_samples(target, sr);
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            // Emit complete speech segment
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                                // let duration = speech_buffer.len() as f32 / sr as f32;
                                emit_speech_detected(&app, target, b64);
                                let _ = app.emit(
                                    "system-audio-diagnostic",
                                    SystemAudioDiagnostic {
                                        event: "speech-detected",
                                        sample_rate: sr,
                                        rms,
                                        peak,
                                        speech_chunks,
                                        silence_chunks,
                                        buffered_samples: speech_buffer.len(),
                                        message: "Speech segment emitted".to_string(),
                                    },
                                );
                            } else {
                                error!("Failed to encode speech to WAV");
                                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                                let _ = app.emit(
                                    "system-audio-diagnostic",
                                    SystemAudioDiagnostic {
                                        event: "audio-encoding-error",
                                        sample_rate: sr,
                                        rms,
                                        peak,
                                        speech_chunks,
                                        silence_chunks,
                                        buffered_samples: speech_buffer.len(),
                                        message: "Failed to encode speech to WAV".to_string(),
                                    },
                                );
                            }
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                            let _ = app.emit(
                                "system-audio-diagnostic",
                                SystemAudioDiagnostic {
                                    event: "speech-discarded",
                                    sample_rate: sr,
                                    rms,
                                    peak,
                                    speech_chunks,
                                    silence_chunks,
                                    buffered_samples: speech_buffer.len(),
                                    message: "Audio too short (likely background noise)"
                                        .to_string(),
                                },
                            );
                        }
                        emit_audio_activity(&app, target, false);

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(mono.into_iter());

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }

                    // Periodically shrink capacity to prevent memory bloat
                    if pre_speech.len() == config.pre_speech_chunks * config.hop_size {
                        pre_speech.shrink_to_fit();
                    }
                }
            }
        }
    }

    emit_audio_activity(&app, target, false);
}

struct LiveAecProcessor {
    processor: Processor,
    frame_size: usize,
    recent_render_levels: VecDeque<(f32, f32)>,
    recent_render_samples: VecDeque<f32>,
}

impl LiveAecProcessor {
    fn new() -> Result<Self, String> {
        let processor = Processor::new(LIVE_AEC_SAMPLE_RATE)
            .map_err(|e| format!("Failed to initialize WebRTC AEC: {}", e))?;
        processor.set_config(Config {
            high_pass_filter: Some(HighPassFilter::default()),
            echo_canceller: Some(EchoCanceller::Full {
                stream_delay_ms: Some(LIVE_AEC_STREAM_DELAY_MS),
            }),
            noise_suppression: Some(NoiseSuppression::default()),
            ..Default::default()
        });

        let frame_size = processor.num_samples_per_frame();
        Ok(Self {
            processor,
            frame_size,
            recent_render_levels: VecDeque::with_capacity(LIVE_AEC_RENDER_HISTORY_FRAMES),
            recent_render_samples: VecDeque::with_capacity(
                frame_size * LIVE_AEC_RENDER_HISTORY_FRAMES,
            ),
        })
    }

    fn frame_size(&self) -> usize {
        self.frame_size
    }

    fn analyze_render_frame(&mut self, samples: &[f32]) {
        if samples.len() != self.frame_size {
            warn!(
                "WebRTC AEC render frame had {} samples; expected {}",
                samples.len(),
                self.frame_size
            );
            return;
        }

        let metrics = calculate_audio_metrics(samples);
        self.recent_render_levels.push_back(metrics);
        while self.recent_render_levels.len() > LIVE_AEC_RENDER_HISTORY_FRAMES {
            self.recent_render_levels.pop_front();
        }
        self.recent_render_samples.extend(samples.iter().copied());
        let max_render_samples = self.frame_size * LIVE_AEC_RENDER_HISTORY_FRAMES;
        while self.recent_render_samples.len() > max_render_samples {
            self.recent_render_samples.pop_front();
        }

        if let Err(e) = self.processor.analyze_render_frame([samples]) {
            warn!("WebRTC AEC render frame failed: {}", e);
        }
    }

    fn recent_render_metrics(&self) -> (f32, f32) {
        self.recent_render_levels
            .iter()
            .fold((0.0f32, 0.0f32), |(max_rms, max_peak), (rms, peak)| {
                (max_rms.max(*rms), max_peak.max(*peak))
            })
    }

    fn max_recent_render_correlation(&self, samples: &[f32]) -> f32 {
        if samples.is_empty() || self.recent_render_samples.len() < samples.len() {
            return 0.0;
        }

        let capture_energy = samples.iter().map(|sample| sample * sample).sum::<f32>();
        if capture_energy <= f32::EPSILON {
            return 0.0;
        }

        let render_samples: Vec<f32> = self.recent_render_samples.iter().copied().collect();
        let max_offset = render_samples.len() - samples.len();
        let offset_step = (self.frame_size / 20).max(1);
        let mut best = 0.0f32;
        let mut offset = 0usize;

        loop {
            let window = &render_samples[offset..offset + samples.len()];
            let mut dot = 0.0f32;
            let mut render_energy = 0.0f32;
            for (&capture, &render) in samples.iter().zip(window) {
                dot += capture * render;
                render_energy += render * render;
            }

            if render_energy > f32::EPSILON {
                best = best.max(dot.abs() / (capture_energy * render_energy).sqrt());
            }

            if offset == max_offset {
                break;
            }
            offset = (offset + offset_step).min(max_offset);
        }

        best
    }

    fn max_recent_render_envelope_correlation(&self, samples: &[f32]) -> f32 {
        const ENVELOPE_BINS: usize = 24;

        if samples.is_empty() || self.recent_render_samples.len() < samples.len() {
            return 0.0;
        }

        let capture_envelope = calculate_envelope_bins(samples, ENVELOPE_BINS);
        let capture_energy = capture_envelope
            .iter()
            .map(|sample| sample * sample)
            .sum::<f32>();
        if capture_energy <= f32::EPSILON {
            return 0.0;
        }

        let render_samples: Vec<f32> = self.recent_render_samples.iter().copied().collect();
        let max_offset = render_samples.len() - samples.len();
        let offset_step = (self.frame_size / 4).max(1);
        let mut best = 0.0f32;
        let mut offset = 0usize;

        loop {
            let window = &render_samples[offset..offset + samples.len()];
            let render_envelope = calculate_envelope_bins(window, ENVELOPE_BINS);
            let mut dot = 0.0f32;
            let mut render_energy = 0.0f32;
            for (&capture, &render) in capture_envelope.iter().zip(&render_envelope) {
                dot += capture * render;
                render_energy += render * render;
            }

            if render_energy > f32::EPSILON {
                best = best.max(dot / (capture_energy * render_energy).sqrt());
            }

            if offset == max_offset {
                break;
            }
            offset = (offset + offset_step).min(max_offset);
        }

        best
    }

    fn should_suppress_residual_echo(&self, samples: &[f32]) -> bool {
        let (render_rms, render_peak) = self.recent_render_metrics();
        if render_rms < LIVE_AEC_RENDER_ACTIVE_RMS && render_peak < LIVE_AEC_RENDER_ACTIVE_PEAK {
            return false;
        }

        let (capture_rms, capture_peak) = calculate_audio_metrics(samples);
        let quiet_residual = capture_rms <= render_rms * LIVE_AEC_RESIDUAL_ECHO_RMS_RATIO
            && capture_peak <= render_peak * LIVE_AEC_RESIDUAL_ECHO_PEAK_RATIO;
        if quiet_residual {
            return true;
        }

        let likely_correlated_echo = capture_rms <= render_rms * LIVE_AEC_CORRELATED_ECHO_RMS_RATIO
            && capture_peak <= render_peak * LIVE_AEC_CORRELATED_ECHO_PEAK_RATIO
            && self.max_recent_render_correlation(samples) >= LIVE_AEC_ECHO_CORRELATION_THRESHOLD;
        if likely_correlated_echo {
            return true;
        }

        let below_local_speech_floor = capture_rms < LIVE_AEC_LOCAL_SPEECH_RMS_FLOOR
            && capture_peak < LIVE_AEC_LOCAL_SPEECH_PEAK_FLOOR;
        let likely_filtered_echo = below_local_speech_floor
            && capture_rms <= render_rms * LIVE_AEC_FILTERED_ECHO_RMS_RATIO
            && capture_peak <= render_peak * LIVE_AEC_FILTERED_ECHO_PEAK_RATIO
            && self.max_recent_render_envelope_correlation(samples)
                >= LIVE_AEC_ECHO_ENVELOPE_CORRELATION_THRESHOLD;
        likely_filtered_echo
    }

    fn process_capture_frame(&mut self, samples: &[f32]) -> Vec<f32> {
        if samples.len() != self.frame_size {
            warn!(
                "WebRTC AEC capture frame had {} samples; expected {}",
                samples.len(),
                self.frame_size
            );
            return Vec::new();
        }

        let mut frame = vec![samples.to_vec()];
        if let Err(e) = self.processor.process_capture_frame(&mut frame) {
            warn!("WebRTC AEC capture frame failed: {}", e);
        }
        if self.should_suppress_residual_echo(&frame[0]) {
            frame[0].fill(0.0);
        }
        frame.pop().unwrap_or_default()
    }

    fn stats(&self) -> webrtc_audio_processing::Stats {
        self.processor.get_stats()
    }
}

struct QueuedLiveAudioFrame {
    sequence: u64,
    samples: Vec<f32>,
}

struct LiveAecWorker {
    aec: LiveAecProcessor,
    frame_size: usize,
    render_buffer: Vec<f32>,
    capture_buffer: Vec<f32>,
    render_frames: VecDeque<QueuedLiveAudioFrame>,
    capture_frames: VecDeque<QueuedLiveAudioFrame>,
    next_render_sequence: u64,
    next_capture_sequence: u64,
    render_capture_sequence_offset: Option<i64>,
    zero_render_frame: Vec<f32>,
}

impl LiveAecWorker {
    fn new() -> Result<Self, String> {
        let aec = LiveAecProcessor::new()?;
        let frame_size = aec.frame_size();

        Ok(Self {
            aec,
            frame_size,
            render_buffer: Vec::with_capacity(frame_size * 2),
            capture_buffer: Vec::with_capacity(frame_size * 2),
            render_frames: VecDeque::new(),
            capture_frames: VecDeque::new(),
            next_render_sequence: 0,
            next_capture_sequence: 0,
            render_capture_sequence_offset: None,
            zero_render_frame: vec![0.0; frame_size],
        })
    }

    #[cfg(test)]
    fn frame_size(&self) -> usize {
        self.frame_size
    }

    fn push_render_samples(&mut self, samples: &[f32]) {
        self.render_buffer.extend_from_slice(samples);

        while self.render_buffer.len() >= self.frame_size {
            let frame_samples: Vec<f32> = self.render_buffer.drain(..self.frame_size).collect();
            self.render_frames.push_back(QueuedLiveAudioFrame {
                sequence: self.next_render_sequence,
                samples: frame_samples,
            });
            self.next_render_sequence += 1;
        }

        if self.capture_frames.is_empty() {
            self.analyze_render_backlog_until_latest();
        }
    }

    fn push_capture_samples(&mut self, samples: &[f32]) {
        self.capture_buffer.extend_from_slice(samples);

        while self.capture_buffer.len() >= self.frame_size {
            let frame_samples: Vec<f32> = self.capture_buffer.drain(..self.frame_size).collect();
            self.capture_frames.push_back(QueuedLiveAudioFrame {
                sequence: self.next_capture_sequence,
                samples: frame_samples,
            });
            self.next_capture_sequence += 1;
        }
    }

    fn process_ready(&mut self, render_open: bool) -> Vec<f32> {
        let mut output = Vec::new();

        while !self.capture_frames.is_empty() {
            let Some(render_frame) = self.take_aligned_render_frame(render_open) else {
                break;
            };
            let capture_frame = self
                .capture_frames
                .pop_front()
                .expect("capture frame checked above");

            self.aec.analyze_render_frame(&render_frame);
            output.extend(self.aec.process_capture_frame(&capture_frame.samples));
        }

        if self.capture_frames.is_empty() {
            self.analyze_render_backlog_until_latest();
        }

        output
    }

    fn stats(&self) -> webrtc_audio_processing::Stats {
        self.aec.stats()
    }

    fn analyze_render_backlog_until_latest(&mut self) {
        while self.render_frames.len() > LIVE_AEC_RENDER_QUEUE_TARGET_FRAMES {
            if let Some(frame) = self.render_frames.pop_front() {
                self.aec.analyze_render_frame(&frame.samples);
            }
        }
    }

    fn take_aligned_render_frame(&mut self, render_open: bool) -> Option<Vec<f32>> {
        let capture_sequence = self.capture_frames.front()?.sequence;

        if self.render_capture_sequence_offset.is_none() {
            if let Some(render_frame) = self.render_frames.back() {
                self.render_capture_sequence_offset =
                    Some(render_frame.sequence as i64 - capture_sequence as i64);
            } else if render_open {
                return None;
            } else {
                return Some(self.zero_render_frame.clone());
            }
        }

        let target_sequence =
            capture_sequence as i64 + self.render_capture_sequence_offset.unwrap_or_default();

        while self
            .render_frames
            .front()
            .is_some_and(|frame| (frame.sequence as i64) < target_sequence)
        {
            if let Some(frame) = self.render_frames.pop_front() {
                self.aec.analyze_render_frame(&frame.samples);
            }
        }

        match self.render_frames.front() {
            Some(frame) if frame.sequence as i64 == target_sequence => {
                self.render_frames.pop_front().map(|frame| frame.samples)
            }
            Some(frame) => {
                self.render_capture_sequence_offset =
                    Some(frame.sequence as i64 - capture_sequence as i64);
                self.render_frames.pop_front().map(|frame| frame.samples)
            }
            None if render_open => None,
            None => Some(self.zero_render_frame.clone()),
        }
    }
}

struct LinearResampler {
    from_rate: u32,
    to_rate: u32,
    step: f64,
    position: f64,
    buffer: VecDeque<f32>,
}

impl LinearResampler {
    fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            from_rate,
            to_rate,
            step: from_rate as f64 / to_rate as f64,
            position: 0.0,
            buffer: VecDeque::new(),
        }
    }

    fn process_sample(&mut self, sample: f32) -> Vec<f32> {
        self.process_chunk(&[sample])
    }

    fn process_chunk(&mut self, samples: &[f32]) -> Vec<f32> {
        if self.from_rate == self.to_rate {
            return samples.to_vec();
        }

        self.buffer.extend(samples.iter().copied());
        let mut output = Vec::new();

        while self.buffer.len() >= 2 && self.position + 1.0 < self.buffer.len() as f64 {
            let idx = self.position.floor() as usize;
            let frac = (self.position - idx as f64) as f32;
            let a = self.buffer[idx];
            let b = self.buffer[idx + 1];
            output.push(a + (b - a) * frac);
            self.position += self.step;
        }

        let max_drain = self.buffer.len().saturating_sub(1);
        let drain = (self.position.floor() as usize).min(max_drain);
        for _ in 0..drain {
            self.buffer.pop_front();
        }
        self.position -= drain as f64;

        output
    }
}

fn find_microphone_device(
    input_device_name: Option<String>,
) -> Result<(cpal::Device, String), String> {
    let host = cpal::default_host();

    if let Some(name) = input_device_name.as_deref().filter(|name| !name.is_empty()) {
        match host.input_devices() {
            Ok(devices) => {
                for device in devices {
                    let device_name = device
                        .name()
                        .unwrap_or_else(|_| "Unknown microphone".into());
                    if device_name == name
                        || device_name.contains(name)
                        || name.contains(&device_name)
                    {
                        return Ok((device, device_name));
                    }
                }
                warn!(
                    "Configured microphone '{}' not found by cpal; using default microphone",
                    name
                );
            }
            Err(e) => warn!("Failed to enumerate microphones: {}", e),
        }
    }

    let device = host
        .default_input_device()
        .ok_or_else(|| "No default microphone found".to_string())?;
    let label = device
        .name()
        .unwrap_or_else(|_| "Default microphone".into());
    Ok((device, label))
}

fn select_microphone_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    if let Ok(mut configs) = device.supported_input_configs() {
        if let Some(config) = configs.find(|config| {
            config.channels() >= 1
                && config.min_sample_rate().0 <= LIVE_AEC_SAMPLE_RATE
                && config.max_sample_rate().0 >= LIVE_AEC_SAMPLE_RATE
        }) {
            return Ok(config.with_sample_rate(cpal::SampleRate(LIVE_AEC_SAMPLE_RATE)));
        }
    }

    device
        .default_input_config()
        .map_err(|e| format!("Failed to read default microphone config: {}", e))
}

fn handle_microphone_input<T, F>(
    data: &[T],
    channels: usize,
    resampler: &mut LinearResampler,
    tx: &mpsc::Sender<Vec<f32>>,
    convert: F,
) where
    T: Copy,
    F: Fn(T) -> f32,
{
    if channels == 0 {
        return;
    }

    let mut mono = Vec::with_capacity(data.len() / channels + 1);
    for frame in data.chunks(channels) {
        let sum = frame
            .iter()
            .fold(0.0f32, |acc, sample| acc + convert(*sample));
        mono.push((sum / frame.len() as f32).clamp(-1.0, 1.0));
    }

    let resampled = resampler.process_chunk(&mono);
    if resampled.is_empty() {
        return;
    }

    let _ = tx.try_send(resampled);
}

fn start_microphone_stream(
    input_device_name: Option<String>,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<(cpal::Stream, u32, String), String> {
    let (device, device_label) = find_microphone_device(input_device_name)?;
    let supported_config = select_microphone_config(&device)?;
    let sample_format = supported_config.sample_format();
    let sample_rate = supported_config.sample_rate().0;
    let config: StreamConfig = supported_config.into();
    let channels = config.channels as usize;

    macro_rules! build_stream {
        ($sample_ty:ty, $convert:expr) => {{
            let mut resampler = LinearResampler::new(sample_rate, LIVE_AEC_SAMPLE_RATE);
            let tx = tx.clone();
            device.build_input_stream(
                &config,
                move |data: &[$sample_ty], _| {
                    handle_microphone_input(data, channels, &mut resampler, &tx, $convert);
                },
                |err| error!("Live Suggest microphone stream error: {}", err),
                None,
            )
        }};
    }

    let stream = match sample_format {
        SampleFormat::F32 => build_stream!(f32, |s: f32| s),
        SampleFormat::F64 => build_stream!(f64, |s: f64| s as f32),
        SampleFormat::I8 => build_stream!(i8, |s: i8| s as f32 / i8::MAX as f32),
        SampleFormat::I16 => build_stream!(i16, |s: i16| s as f32 / i16::MAX as f32),
        SampleFormat::I32 => build_stream!(i32, |s: i32| s as f32 / i32::MAX as f32),
        SampleFormat::I64 => build_stream!(i64, |s: i64| s as f32 / i64::MAX as f32),
        SampleFormat::U8 => build_stream!(u8, |s: u8| (s as f32 - 128.0) / 128.0),
        SampleFormat::U16 => build_stream!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
        SampleFormat::U32 => build_stream!(u32, |s: u32| {
            (s as f32 - 2_147_483_648.0) / 2_147_483_648.0
        }),
        SampleFormat::U64 => build_stream!(u64, |s: u64| {
            (s as f64 - 9_223_372_036_854_775_808.0) as f32 / 9_223_372_036_854_775_808.0_f32
        }),
        _ => {
            return Err(format!(
                "Unsupported microphone sample format: {:?}",
                sample_format
            ))
        }
    }
    .map_err(|e| format!("Failed to build microphone stream: {}", e))?;

    Ok((stream, sample_rate, device_label))
}

async fn run_live_aec_processing(
    app: AppHandle,
    mut worker: LiveAecWorker,
    mut raw_mic_rx: mpsc::Receiver<Vec<f32>>,
    mut render_rx: mpsc::Receiver<Vec<f32>>,
    you_tx: mpsc::Sender<f32>,
) {
    let mut last_stats_at = Instant::now();
    let mut mic_open = true;
    let mut render_open = true;

    while mic_open || render_open {
        tokio::select! {
            mic_samples = raw_mic_rx.recv(), if mic_open => {
                if let Some(samples) = mic_samples {
                    worker.push_capture_samples(&samples);
                } else {
                    mic_open = false;
                }
            }
            render_samples = render_rx.recv(), if render_open => {
                if let Some(samples) = render_samples {
                    worker.push_render_samples(&samples);
                } else {
                    render_open = false;
                }
            }
        };

        let processed = worker.process_ready(render_open);
        let stats = if !processed.is_empty() && last_stats_at.elapsed() >= Duration::from_secs(5) {
            Some(worker.stats())
        } else {
            None
        };

        let processed_len = processed.len();
        for sample in processed {
            let _ = you_tx.try_send(sample);
        }

        if let Some(stats) = stats {
            last_stats_at = Instant::now();
            let _ = app.emit(
                "system-audio-diagnostic",
                SystemAudioDiagnostic {
                    event: "live-aec-stats",
                    sample_rate: LIVE_AEC_SAMPLE_RATE,
                    rms: 0.0,
                    peak: 0.0,
                    speech_chunks: 0,
                    silence_chunks: 0,
                    buffered_samples: processed_len,
                    message: format!(
                        "configured_delay_ms={}, reported_delay_ms={:?}, echo_return_loss={:?}, echo_return_loss_enhancement={:?}, residual_echo_likelihood={:?}",
                        LIVE_AEC_STREAM_DELAY_MS,
                        stats.delay_ms,
                        stats.echo_return_loss,
                        stats.echo_return_loss_enhancement,
                        stats.residual_echo_likelihood
                    ),
                },
            );
        }
    }
}

#[tauri::command]
pub async fn start_live_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    output_device_id: Option<String>,
    input_device_name: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    {
        let guard = state
            .live_stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire live capture lock: {}", e))?;
        if guard.is_some() {
            return Err("Live audio capture already running".to_string());
        }
    }

    let vad_config = vad_config.unwrap_or_default();
    let output_label = output_device_id
        .clone()
        .unwrap_or_else(|| "default".to_string());

    let speaker_input = SpeakerInput::new_with_device(output_device_id).map_err(|e| {
        error!("Failed to create live speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;
    let speaker_stream = speaker_input.stream();
    let speaker_sr = speaker_stream.sample_rate();

    if !(8000..=96000).contains(&speaker_sr) {
        return Err(format!(
            "Invalid system audio sample rate: {}. Expected 8000-96000 Hz",
            speaker_sr
        ));
    }

    let aec_worker = LiveAecWorker::new()?;
    let (raw_mic_tx, raw_mic_rx) = mpsc::channel::<Vec<f32>>(LIVE_RAW_MIC_CHANNEL_CAPACITY);
    let (render_tx, render_rx) = mpsc::channel::<Vec<f32>>(LIVE_AEC_RENDER_CHANNEL_CAPACITY);
    let (you_tx, you_rx) = mpsc::channel::<f32>(LIVE_AUDIO_CHANNEL_CAPACITY);
    let (them_tx, them_rx) = mpsc::channel::<f32>(LIVE_AUDIO_CHANNEL_CAPACITY);

    let (mic_init_tx, mic_init_rx) = std::sync::mpsc::channel::<Result<(u32, String), String>>();
    let (mic_stop_tx, mic_stop_rx) = std::sync::mpsc::channel::<()>();
    let mic_thread = std::thread::spawn(move || {
        let (stream, mic_sr, mic_label) =
            match start_microphone_stream(input_device_name, raw_mic_tx) {
                Ok(result) => result,
                Err(e) => {
                    let _ = mic_init_tx.send(Err(e));
                    return;
                }
            };

        if let Err(e) = stream.play() {
            let _ = mic_init_tx.send(Err(format!("Failed to start microphone stream: {}", e)));
            return;
        }

        let _ = mic_init_tx.send(Ok((mic_sr, mic_label)));
        let _ = mic_stop_rx.recv();
    });

    let (mic_sr, mic_label) = match mic_init_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            let _ = mic_stop_tx.send(());
            let _ = mic_thread.join();
            return Err(e);
        }
        Err(_) => {
            let _ = mic_stop_tx.send(());
            let _ = mic_thread.join();
            return Err("Timed out while starting microphone stream".to_string());
        }
    };

    let aec_task = tokio::spawn(run_live_aec_processing(
        app.clone(),
        aec_worker,
        raw_mic_rx,
        render_rx,
        you_tx,
    ));

    let app_for_render = app.clone();
    let render_task = tokio::spawn(async move {
        let mut stream = speaker_stream;
        let mut resampler = LinearResampler::new(speaker_sr, LIVE_AEC_SAMPLE_RATE);
        let mut batch = Vec::with_capacity((LIVE_AEC_SAMPLE_RATE / 100) as usize);

        while let Some(sample) = stream.next().await {
            for resampled in resampler.process_sample(sample) {
                batch.push(resampled);
                if batch.len() >= (LIVE_AEC_SAMPLE_RATE / 100) as usize {
                    let _ = render_tx.try_send(batch.clone());
                    for sample in batch.drain(..) {
                        let _ = them_tx.try_send(sample);
                    }
                }
            }
        }

        if !batch.is_empty() {
            let _ = render_tx.try_send(batch.clone());
            for sample in batch.drain(..) {
                let _ = them_tx.try_send(sample);
            }
        }

        let _ = app_for_render.emit("live-audio-error", "System audio stream ended");
    });

    let you_vad = tokio::spawn(run_vad_capture(
        app.clone(),
        ReceiverStream::new(you_rx),
        LIVE_AEC_SAMPLE_RATE,
        vad_config.clone(),
        SpeechTarget::Live(LiveSpeaker::You),
    ));
    let them_vad = tokio::spawn(run_vad_capture(
        app.clone(),
        ReceiverStream::new(them_rx),
        LIVE_AEC_SAMPLE_RATE,
        vad_config,
        SpeechTarget::Live(LiveSpeaker::Them),
    ));

    let _ = app.emit("live-capture-started", LIVE_AEC_SAMPLE_RATE);
    let _ = app.emit(
        "system-audio-diagnostic",
        SystemAudioDiagnostic {
            event: "live-capture-started",
            sample_rate: LIVE_AEC_SAMPLE_RATE,
            rms: 0.0,
            peak: 0.0,
            speech_chunks: 0,
            silence_chunks: 0,
            buffered_samples: 0,
            message: format!(
                "output={}, output_sr={}, mic={}, mic_sr={}, aec_sr={}",
                output_label, speaker_sr, mic_label, mic_sr, LIVE_AEC_SAMPLE_RATE
            ),
        },
    );

    let handle = LiveCaptureHandle {
        stop_tx: mic_stop_tx,
        mic_thread: Some(mic_thread),
        aec_task,
        render_task,
        you_vad_task: you_vad,
        them_vad_task: them_vad,
    };

    *state
        .live_stream_task
        .lock()
        .map_err(|e| format!("Failed to store live capture task: {}", e))? = Some(handle);
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set live capturing state: {}", e))? = true;

    Ok(())
}

#[tauri::command]
pub async fn stop_live_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    {
        let mut guard = state
            .live_stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire live capture task lock: {}", e))?;
        if let Some(handle) = guard.take() {
            handle.stop();
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update live capturing state: {}", e))? = false;

    emit_audio_activity(&app, SpeechTarget::Live(LiveSpeaker::You), false);
    emit_audio_activity(&app, SpeechTarget::Live(LiveSpeaker::Them), false);
    let _ = app.emit("live-capture-stopped", ());

    Ok(())
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Atomic flag for manual stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Clean up event listener (CRITICAL)
    app.unlisten(stop_listener);

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn calculate_envelope_bins(samples: &[f32], bins: usize) -> Vec<f32> {
    if samples.is_empty() || bins == 0 {
        return Vec::new();
    }

    let mut envelope = Vec::with_capacity(bins);
    for bin in 0..bins {
        let start = bin * samples.len() / bins;
        let end = ((bin + 1) * samples.len() / bins).max(start + 1);
        let end = end.min(samples.len());
        let sum_abs = samples[start..end]
            .iter()
            .map(|sample| sample.abs())
            .sum::<f32>();
        envelope.push(sum_abs / (end - start) as f32);
    }

    envelope
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Abort task in separate scope (Send trait fix)
    {
        let mut guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;

        if let Some(task) = guard.take() {
            task.abort();
        }
    }

    // LONGER delay for proper cleanup (300ms instead of 150ms)
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    // Mark as not capturing
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {}", e))? = false;

    // Additional cleanup delay (CRITICAL for mic indicator)
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Emit stopped event
    let _ = app.emit("system-audio-activity", false);
    let _ = app.emit("capture-stopped", ());
    Ok(())
}

/// Manual stop for continuous recording
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("manual-stop-continuous", ());

    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(is_capturing)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    Ok(sr)
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        error!("Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod commands_tests;
