use super::*;

#[derive(Debug)]
struct VadProbeResult {
    utterance_detected: bool,
    max_rms: f32,
    max_peak: f32,
    max_speech_chunks: usize,
}

#[test]
fn aec_suppresses_far_end_echo_before_you_vad() {
    let worker = LiveAecWorker::new().expect("AEC worker should initialize");
    let frame_size = worker.frame_size();
    let sample_rate = LIVE_AEC_SAMPLE_RATE as usize;
    let total_samples = align_to_frame_size(sample_rate * 4, frame_size);
    let speech_samples = align_to_frame_size(sample_rate * 2, frame_size);
    let render = synthetic_far_end_speech_like(total_samples, speech_samples);
    let mic = delayed_attenuated_copy(&render, sample_rate * 45 / 1000, 0.55);
    let vad_config = VadConfig::default();

    let raw_echo_vad = probe_you_vad(&mic, &vad_config);
    assert!(
        raw_echo_vad.utterance_detected,
        "test fixture should be loud enough to trigger VAD before AEC: max_rms={}, max_peak={}, max_speech_chunks={}",
        raw_echo_vad.max_rms,
        raw_echo_vad.max_peak,
        raw_echo_vad.max_speech_chunks
    );

    let processed = process_with_live_aec_worker(&render, &mic, 4);

    let processed_vad = probe_you_vad(&processed, &vad_config);
    assert!(
        !processed_vad.utterance_detected,
        "far-end echo alone was classified as a You utterance after AEC: max_rms={}, max_peak={}, max_speech_chunks={}",
        processed_vad.max_rms,
        processed_vad.max_peak,
        processed_vad.max_speech_chunks
    );
}

#[test]
fn aec_preserves_local_speech_during_double_talk() {
    let worker = LiveAecWorker::new().expect("AEC worker should initialize");
    let frame_size = worker.frame_size();
    let sample_rate = LIVE_AEC_SAMPLE_RATE as usize;
    let total_samples = align_to_frame_size(sample_rate * 6, frame_size);
    let local_start = align_to_frame_size(sample_rate * 5 / 2, frame_size);
    let local_end = align_to_frame_size(sample_rate * 16 / 5, frame_size);
    let render = synthetic_far_end_speech_like(total_samples, total_samples);
    let mut mic = delayed_attenuated_copy(&render, sample_rate * 45 / 1000, 0.45);
    let local_speech = synthetic_local_speech_like(total_samples, local_start, local_end);
    let vad_config = VadConfig::default();

    for (mic_sample, local_sample) in mic.iter_mut().zip(local_speech) {
        *mic_sample = (*mic_sample + local_sample).clamp(-1.0, 1.0);
    }

    let processed = process_with_live_aec_worker(&render, &mic, 3);

    let far_only_before_vad = probe_you_vad(
        &processed[align_to_frame_size(sample_rate * 7 / 5, frame_size)
            ..align_to_frame_size(sample_rate * 2, frame_size)],
        &vad_config,
    );
    let far_only_after_vad = probe_you_vad(
        &processed[align_to_frame_size(sample_rate * 21 / 5, frame_size)
            ..align_to_frame_size(sample_rate * 5, frame_size)],
        &vad_config,
    );
    assert!(
        !far_only_before_vad.utterance_detected && !far_only_after_vad.utterance_detected,
        "far-only echo windows should not create You utterances after AEC: before={far_only_before_vad:?}, after={far_only_after_vad:?}"
    );

    let local_speech_vad = probe_you_vad(
        &processed[local_start - align_to_frame_size(sample_rate / 20, frame_size)
            ..local_end + align_to_frame_size(sample_rate / 4, frame_size)],
        &vad_config,
    );
    assert!(
        local_speech_vad.utterance_detected,
        "local speech during double-talk should still create a You utterance after AEC: {local_speech_vad:?}"
    );
}

#[test]
fn aec_suppresses_loud_far_end_leakage_after_local_speech() {
    let worker = LiveAecWorker::new().expect("AEC worker should initialize");
    let frame_size = worker.frame_size();
    let sample_rate = LIVE_AEC_SAMPLE_RATE as usize;
    let total_samples = align_to_frame_size(sample_rate * 5, frame_size);
    let local_start = align_to_frame_size(sample_rate / 5, frame_size);
    let local_end = align_to_frame_size(sample_rate, frame_size);
    let far_start = local_end;
    let far_end = align_to_frame_size(sample_rate * 3, frame_size);
    let render = synthetic_speech_like_in_range(total_samples, far_start, far_end, 135.0, 0.16);
    let mut mic = delayed_attenuated_copy(&render, sample_rate * 45 / 1000, 0.95);
    let local_speech =
        synthetic_speech_like_in_range(total_samples, local_start, local_end, 205.0, 0.18);
    let vad_config = VadConfig::default();

    for (mic_sample, local_sample) in mic.iter_mut().zip(local_speech) {
        *mic_sample = (*mic_sample + local_sample).clamp(-1.0, 1.0);
    }

    let raw_far_leakage_vad = probe_you_vad(
        &mic[far_start + align_to_frame_size(sample_rate / 5, frame_size)..far_end],
        &vad_config,
    );
    assert!(
        raw_far_leakage_vad.utterance_detected,
        "test fixture should be loud enough to trigger You VAD before AEC: {raw_far_leakage_vad:?}"
    );

    let processed = process_with_live_aec_worker(&render, &mic, 5);

    let local_speech_vad = probe_you_vad(
        &processed[local_start..local_end + align_to_frame_size(sample_rate / 5, frame_size)],
        &vad_config,
    );
    assert!(
        local_speech_vad.utterance_detected,
        "local You speech should still be preserved before Them starts: {local_speech_vad:?}"
    );

    let far_leakage_vad = probe_you_vad(
        &processed[far_start + align_to_frame_size(sample_rate / 5, frame_size)..far_end],
        &vad_config,
    );
    assert!(
        !far_leakage_vad.utterance_detected,
        "loud Them leakage after local speech should not keep/create a You utterance: {far_leakage_vad:?}"
    );
}

#[test]
fn aec_zeroes_far_end_residual_for_live_suggest_vad_sensitivity() {
    let worker = LiveAecWorker::new().expect("AEC worker should initialize");
    let frame_size = worker.frame_size();
    let sample_rate = LIVE_AEC_SAMPLE_RATE as usize;
    let total_samples = align_to_frame_size(sample_rate * 5, frame_size);
    let local_start = align_to_frame_size(sample_rate / 5, frame_size);
    let local_end = align_to_frame_size(sample_rate, frame_size);
    let far_start = local_end;
    let far_end = align_to_frame_size(sample_rate * 3, frame_size);
    let render = synthetic_speech_like_in_range(total_samples, far_start, far_end, 135.0, 0.16);
    let mut mic = filtered_delayed_copy(&render, sample_rate * 45 / 1000, 0.72);
    let local_speech =
        synthetic_speech_like_in_range(total_samples, local_start, local_end, 205.0, 0.18);
    let vad_config = live_suggest_vad_config();

    for (mic_sample, local_sample) in mic.iter_mut().zip(local_speech) {
        *mic_sample = (*mic_sample + local_sample).clamp(-1.0, 1.0);
    }

    let processed = process_with_live_aec_worker(&render, &mic, 5);

    let local_speech_vad = probe_you_vad(
        &processed[local_start..local_end + align_to_frame_size(sample_rate / 5, frame_size)],
        &vad_config,
    );
    assert!(
        local_speech_vad.utterance_detected,
        "local You speech should remain detectable with Live Suggest VAD: {local_speech_vad:?}"
    );

    let far_window_start = far_start + align_to_frame_size(sample_rate / 5, frame_size);
    let far_window = &processed[far_window_start..far_end];
    let gated_far_window = apply_noise_gate(far_window, vad_config.noise_gate_threshold);
    let (far_rms, far_peak) = calculate_audio_metrics(&gated_far_window);
    assert!(
        far_rms < vad_config.noise_gate_threshold && far_peak < vad_config.peak_threshold,
        "far-end residual inside/after a You segment should be near-zero for Live Suggest VAD: rms={far_rms}, peak={far_peak}, config={vad_config:?}"
    );
}

#[test]
fn you_segments_keep_no_trailing_silence_for_stt() {
    assert_eq!(
        trailing_silence_to_keep_samples(SpeechTarget::Live(LiveSpeaker::You), 48_000),
        0
    );
    assert_eq!(
        trailing_silence_to_keep_samples(SpeechTarget::Live(LiveSpeaker::Them), 48_000),
        7_200
    );
    assert_eq!(
        trailing_silence_to_keep_samples(SpeechTarget::Legacy, 48_000),
        7_200
    );
}

#[test]
fn mic_callback_enqueues_raw_chunks_for_aec_worker_only() {
    let (tx, mut rx) = mpsc::channel::<Vec<f32>>(4);
    let mut resampler = LinearResampler::new(LIVE_AEC_SAMPLE_RATE, LIVE_AEC_SAMPLE_RATE);
    let interleaved_stereo = [0.20f32, 0.10, -0.40, -0.20, 0.30, -0.10, -0.50, 0.50];

    handle_microphone_input(&interleaved_stereo, 2, &mut resampler, &tx, |s| s);

    let raw_chunk = rx
        .try_recv()
        .expect("mic callback should enqueue one raw chunk for the AEC worker");
    assert_samples_close(&raw_chunk, &[0.15, -0.3, 0.1, 0.0]);
    assert!(
        rx.try_recv().is_err(),
        "mic callback should not enqueue extra chunks or directly feed You VAD samples"
    );
}

fn assert_samples_close(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (*actual - *expected).abs() < 1.0e-6,
            "sample {index} differed: actual={actual}, expected={expected}"
        );
    }
}

fn process_with_live_aec_worker(render: &[f32], mic: &[f32], render_lag_frames: usize) -> Vec<f32> {
    let mut worker = LiveAecWorker::new().expect("AEC worker should initialize");
    let frame_size = worker.frame_size();
    assert_eq!(render.len(), mic.len());
    assert_eq!(render.len() % frame_size, 0);

    let frame_count = render.len() / frame_size;
    let mut processed = Vec::with_capacity(mic.len());

    for step in 0..frame_count + render_lag_frames {
        if step < frame_count {
            let start = step * frame_size;
            worker.push_capture_samples(&mic[start..start + frame_size]);
        }

        if step >= render_lag_frames {
            let render_frame = step - render_lag_frames;
            if render_frame < frame_count {
                let start = render_frame * frame_size;
                worker.push_render_samples(&render[start..start + frame_size]);
            }
        }

        processed.extend(worker.process_ready(true));
    }

    processed.extend(worker.process_ready(false));
    assert_eq!(processed.len(), mic.len());
    processed
}

fn align_to_frame_size(samples: usize, frame_size: usize) -> usize {
    samples / frame_size * frame_size
}

fn synthetic_far_end_speech_like(total_samples: usize, speech_samples: usize) -> Vec<f32> {
    let sample_rate = LIVE_AEC_SAMPLE_RATE as f32;
    let mut samples = Vec::with_capacity(total_samples);

    for n in 0..total_samples {
        if n >= speech_samples {
            samples.push(0.0);
            continue;
        }

        let t = n as f32 / sample_rate;
        let speech_progress = n as f32 / speech_samples as f32;
        let attack = (speech_progress / 0.03).min(1.0);
        let release = ((1.0 - speech_progress) / 0.06).min(1.0);
        let syllable = 0.58 + 0.42 * (std::f32::consts::TAU * 4.1 * t).sin().max(0.0);
        let envelope = attack * release * syllable;
        let f0 = 135.0 + 22.0 * (std::f32::consts::TAU * 0.7 * t).sin();
        let voiced = (std::f32::consts::TAU * f0 * t).sin()
            + 0.45 * (std::f32::consts::TAU * f0 * 2.0 * t + 0.3).sin()
            + 0.25 * (std::f32::consts::TAU * f0 * 3.0 * t + 0.7).sin();
        let fricative = 0.18
            * ((std::f32::consts::TAU * 1780.0 * t).sin()
                + 0.5 * (std::f32::consts::TAU * 2930.0 * t + 0.4).sin());

        samples.push(0.16 * envelope * (0.82 * voiced + fricative));
    }

    samples
}

fn synthetic_local_speech_like(total_samples: usize, start: usize, end: usize) -> Vec<f32> {
    synthetic_speech_like_in_range(total_samples, start, end, 205.0, 0.18)
}

fn synthetic_speech_like_in_range(
    total_samples: usize,
    start: usize,
    end: usize,
    base_f0: f32,
    amplitude: f32,
) -> Vec<f32> {
    let sample_rate = LIVE_AEC_SAMPLE_RATE as f32;
    let duration = (end - start) as f32 / sample_rate;
    let mut samples = Vec::with_capacity(total_samples);

    for n in 0..total_samples {
        if n < start || n >= end {
            samples.push(0.0);
            continue;
        }

        let t = n as f32 / sample_rate;
        let local_t = (n - start) as f32 / sample_rate;
        let attack = (local_t / 0.04).min(1.0);
        let release = ((duration - local_t) / 0.08).min(1.0);
        let syllable = 0.54 + 0.46 * (std::f32::consts::TAU * 5.3 * local_t).sin().abs();
        let envelope = attack * release * syllable;
        let f0 = base_f0 + 18.0 * (std::f32::consts::TAU * 0.9 * local_t).sin();
        let voiced = (std::f32::consts::TAU * f0 * t + 0.2).sin()
            + 0.38 * (std::f32::consts::TAU * f0 * 2.0 * t + 0.8).sin()
            + 0.20 * (std::f32::consts::TAU * f0 * 3.0 * t + 1.1).sin();
        let fricative = 0.14
            * ((std::f32::consts::TAU * 2210.0 * t + 0.5).sin()
                + 0.45 * (std::f32::consts::TAU * 3490.0 * t + 1.2).sin());

        samples.push(amplitude * envelope * (0.86 * voiced + fricative));
    }

    samples
}

fn delayed_attenuated_copy(samples: &[f32], delay_samples: usize, attenuation: f32) -> Vec<f32> {
    let mut delayed = vec![0.0; samples.len()];
    for i in delay_samples..samples.len() {
        delayed[i] = samples[i - delay_samples] * attenuation;
    }
    delayed
}

fn filtered_delayed_copy(samples: &[f32], delay_samples: usize, attenuation: f32) -> Vec<f32> {
    let mut delayed = vec![0.0; samples.len()];
    let mut low_pass = 0.0f32;
    let mut previous = 0.0f32;

    for i in delay_samples..samples.len() {
        let source = samples[i - delay_samples];
        low_pass = 0.82 * low_pass + 0.18 * source;
        let high_pass = source - previous;
        previous = source;
        delayed[i] = attenuation * (0.78 * low_pass + 0.22 * high_pass).clamp(-1.0, 1.0);
    }

    delayed
}

fn live_suggest_vad_config() -> VadConfig {
    VadConfig {
        enabled: true,
        hop_size: 1024,
        sensitivity_rms: 0.0035,
        peak_threshold: 0.012,
        silence_chunks: 45,
        min_speech_chunks: 7,
        pre_speech_chunks: 12,
        noise_gate_threshold: 0.001,
        max_recording_duration_secs: 180,
    }
}

fn probe_you_vad(samples: &[f32], config: &VadConfig) -> VadProbeResult {
    let mut in_speech = false;
    let mut speech_chunks = 0;
    let mut silence_chunks = 0;
    let mut max_speech_chunks = 0;
    let mut max_rms = 0.0f32;
    let mut max_peak = 0.0f32;

    for chunk in samples.chunks(config.hop_size) {
        if chunk.len() < config.hop_size {
            break;
        }

        let gated = apply_noise_gate(chunk, config.noise_gate_threshold);
        let (rms, peak) = calculate_audio_metrics(&gated);
        let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;
        max_rms = max_rms.max(rms);
        max_peak = max_peak.max(peak);

        if is_speech {
            if !in_speech {
                in_speech = true;
                speech_chunks = 0;
            }

            speech_chunks += 1;
            max_speech_chunks = max_speech_chunks.max(speech_chunks);
            silence_chunks = 0;
            continue;
        }

        if in_speech {
            silence_chunks += 1;
            if silence_chunks >= config.silence_chunks {
                if speech_chunks >= config.min_speech_chunks {
                    return VadProbeResult {
                        utterance_detected: true,
                        max_rms,
                        max_peak,
                        max_speech_chunks,
                    };
                }

                in_speech = false;
                speech_chunks = 0;
                silence_chunks = 0;
            }
        }
    }

    VadProbeResult {
        utterance_detected: in_speech && speech_chunks >= config.min_speech_chunks,
        max_rms,
        max_peak,
        max_speech_chunks,
    }
}
