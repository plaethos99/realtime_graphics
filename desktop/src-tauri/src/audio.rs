//! Recording sessions: the computer's sound (WASAPI loopback on Windows) and/or the microphone, cut into
//! ~15 s mono 16 kHz WAV chunks. Each chunk goes to the overlay page as an "audio-chunk" event, and the page
//! uploads it to the proxy for transcription. Silent chunks are skipped (Whisper invents words on silence).

use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use serde::Serialize;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const TARGET_RATE: u32 = 16_000;
const CHUNK_SECONDS: f32 = 15.0;
const SILENCE_RMS: f32 = 0.003;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChunk {
    source: &'static str,
    /// Seconds from the start of the recording to the start of this chunk.
    offset: f64,
    seconds: f64,
    /// WAV file, base64.
    wav: String,
}

struct Track {
    source: &'static str,
    rate: u32,
    samples: Vec<f32>, // mono, device rate
    first_at: Option<Instant>,
    last_at: Option<Instant>,
}

pub struct Recorder {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Recorder {
    /// Stop, sending whatever audio is still buffered first.
    pub fn stop(mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Start recording. Returns the recorder and warnings for sources that couldn't be opened
/// (it fails only if no source works).
pub fn start(app: AppHandle, window: &'static str, system: bool, mic: bool) -> Result<(Recorder, Vec<String>), String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Vec<String>, String>>();
    // cpal streams aren't Send on every platform, so one thread owns them for the whole recording.
    let thread = std::thread::spawn(move || {
        let started = Instant::now();
        let host = cpal::default_host();
        let mut streams = Vec::new();
        let mut tracks = Vec::new();
        let mut warnings = Vec::new();
        for (wanted, is_system) in [(system, true), (mic, false)] {
            if !wanted {
                continue;
            }
            match open(&host, is_system) {
                Ok((stream, track)) => {
                    streams.push(stream);
                    tracks.push(track);
                }
                Err(e) => warnings.push(format!("{}: {e}", if is_system { "Computer sound" } else { "Microphone" })),
            }
        }
        eprintln!("recording: {} source(s) open, warnings: {:?}", streams.len(), warnings);
        if streams.is_empty() {
            let _ = ready_tx.send(Err(warnings.join(" ")));
            return;
        }
        let _ = ready_tx.send(Ok(warnings));
        loop {
            let stopping = !matches!(stop_rx.recv_timeout(Duration::from_millis(250)), Err(mpsc::RecvTimeoutError::Timeout));
            for track in &tracks {
                flush(&app, window, track, started, stopping);
            }
            if stopping {
                break;
            }
        }
        drop(streams);
    });
    match ready_rx.recv() {
        Ok(Ok(warnings)) => Ok((Recorder { stop: stop_tx, thread: Some(thread) }, warnings)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("The recording thread stopped unexpectedly.".into()),
    }
}

fn open(host: &cpal::Host, system: bool) -> Result<(cpal::Stream, Arc<Mutex<Track>>), String> {
    #[cfg(not(windows))]
    if system {
        return Err("recording the computer's sound is only supported on Windows for now".into());
    }
    let device = if system { host.default_output_device() } else { host.default_input_device() }
        .ok_or_else(|| "no device found".to_string())?;
    // On Windows, opening the output device for input records what it plays (loopback).
    let supported = if system { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config = supported.config();
    let channels = config.channels.max(1) as usize;
    let track = Arc::new(Mutex::new(Track {
        source: if system { "system" } else { "mic" },
        rate: config.sample_rate,
        samples: Vec::new(),
        first_at: None,
        last_at: None,
    }));
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&device, config, channels, track.clone()),
        cpal::SampleFormat::I16 => build::<i16>(&device, config, channels, track.clone()),
        cpal::SampleFormat::I32 => build::<i32>(&device, config, channels, track.clone()),
        cpal::SampleFormat::U16 => build::<u16>(&device, config, channels, track.clone()),
        other => Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, track))
}

fn build<T>(device: &cpal::Device, config: cpal::StreamConfig, channels: usize, track: Arc<Mutex<Track>>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let now = Instant::now();
                let mut t = track.lock().unwrap();
                if t.first_at.is_none() {
                    t.first_at = Some(now);
                }
                t.last_at = Some(now);
                for frame in data.chunks(channels) {
                    let sum: f32 = frame.iter().map(|&s| s.to_sample::<f32>()).sum();
                    t.samples.push(sum / frame.len() as f32);
                }
            },
            |e| {
                // Loopback reports harmless glitches when playback starts/stops; only log the rest.
                let text = e.to_string();
                if !text.contains("underrun or overrun") {
                    eprintln!("audio stream error: {text}");
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Send the buffered audio as a chunk when it's long enough, the sound paused, or we're stopping.
fn flush(app: &AppHandle, window: &str, track: &Arc<Mutex<Track>>, started: Instant, force: bool) {
    let (samples, rate, first_at, source) = {
        let mut t = track.lock().unwrap();
        let full = t.samples.len() as f32 >= CHUNK_SECONDS * t.rate as f32;
        let paused = t.last_at.is_some_and(|last| last.elapsed() > Duration::from_secs(3)) && !t.samples.is_empty();
        if !(full || paused || force) || t.samples.is_empty() {
            return;
        }
        (std::mem::take(&mut t.samples), t.rate, t.first_at.take(), t.source)
    };
    if samples.len() < rate as usize / 2 {
        return; // under half a second
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    if rms < SILENCE_RMS {
        return;
    }
    let pcm = resample(&samples, rate, TARGET_RATE);
    let chunk = AudioChunk {
        source,
        offset: first_at.map(|f| f.duration_since(started).as_secs_f64()).unwrap_or(0.0),
        seconds: pcm.len() as f64 / TARGET_RATE as f64,
        wav: base64::engine::general_purpose::STANDARD.encode(wav(&pcm, TARGET_RATE)),
    };
    let _ = app.emit_to(window, "audio-chunk", chunk);
}

/// Average blocks of input samples down to the target rate (a box filter is enough for speech).
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    (0..out_len)
        .map(|i| {
            let a = (i as f64 * ratio) as usize;
            let b = (((i + 1) as f64 * ratio) as usize).clamp(a + 1, input.len());
            input[a..b].iter().sum::<f32>() / (b - a) as f32
        })
        .collect()
}

fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}
