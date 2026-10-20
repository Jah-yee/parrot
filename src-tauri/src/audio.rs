//! A take as the interface records it (a WAV file), cleaned the way a voice recording should be: desk rumble
//! filtered out, the silence before and after trimmed, the level evened out. Plus resampling to the 16 kHz the
//! speech models listen at.

use std::io::Cursor;

pub struct Pcm {
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl Pcm {
    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / self.rate as f64
    }
}

/// Read a WAV file (any sample format, any channel count) as mono floats.
pub fn read_wav(bytes: &[u8]) -> Result<Pcm, String> {
    let mut r = hound::WavReader::new(Cursor::new(bytes)).map_err(|e| format!("not a WAV recording: {e}"))?;
    let spec = r.spec();
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().filter_map(Result::ok).map(|s| s as f32 / scale).collect()
        }
    };
    let samples = interleaved.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    Ok(Pcm { samples, rate: spec.sample_rate })
}

pub fn write_wav(path: &std::path::Path, pcm: &Pcm) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: pcm.rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for s in &pcm.samples {
        w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}

/// High-pass the take at 80 Hz (a second-order filter): desk rumble and handling noise out, the voice untouched.
fn high_pass(x: &mut [f32], rate: u32) {
    let w0 = 2.0 * std::f32::consts::PI * 80.0 / rate as f32;
    let alpha = w0.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
    let cos = w0.cos();
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = ((1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0);
    let (a1, a2) = (-2.0 * cos / a0, (1.0 - alpha) / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    for s in x.iter_mut() {
        let y = b0 * *s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = *s;
        y2 = y1;
        y1 = y;
        *s = y;
    }
}

fn db(rms: f32) -> f32 {
    20.0 * rms.max(1e-9).log10()
}

/// Clean a take: high-pass, trim the silence before (keeping 0.15 s) and after (0.25 s) the voice, and level it
/// to about -20 dBFS of speech, never above 0.95. Returns None when nothing but silence was recorded.
pub fn clean(mut pcm: Pcm) -> Option<Pcm> {
    let rate = pcm.rate as usize;
    high_pass(&mut pcm.samples, pcm.rate);
    let frame = (rate / 100).max(1); // 10 ms
    let levels: Vec<f32> = pcm
        .samples
        .chunks(frame)
        .map(|c| db((c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()))
        .collect();
    let loudest = levels.iter().cloned().fold(f32::MIN, f32::max);
    // voice: frames within 35 dB of the loudest, and above the noise floor of a quiet room
    let threshold = (loudest - 35.0).max(-55.0);
    let first = levels.iter().position(|&l| l > threshold)?;
    let last = levels.iter().rposition(|&l| l > threshold)?;
    if loudest < -50.0 {
        return None;
    }
    let start = (first * frame).saturating_sub(rate * 15 / 100);
    let end = ((last + 1) * frame + rate / 4).min(pcm.samples.len());
    let mut s = pcm.samples[start..end].to_vec();
    let voiced: Vec<f32> = s
        .chunks(frame)
        .filter(|c| db((c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32).sqrt()) > threshold)
        .flatten()
        .copied()
        .collect();
    let rms = (voiced.iter().map(|x| x * x).sum::<f32>() / voiced.len().max(1) as f32).sqrt();
    let peak = s.iter().fold(0f32, |m, x| m.max(x.abs()));
    let gain = (0.1 / rms.max(1e-6)).min(0.95 / peak.max(1e-6)).min(30.0);
    for x in &mut s {
        *x *= gain;
    }
    Some(Pcm { samples: s, rate: pcm.rate })
}

/// Resample by linear interpolation, low-passed first when going down so nothing above the new Nyquist folds back.
pub fn resample(pcm: &Pcm, to: u32) -> Vec<f32> {
    if pcm.rate == to {
        return pcm.samples.clone();
    }
    let ratio = pcm.rate as f64 / to as f64;
    let src: Vec<f32> = if ratio > 1.0 {
        // a moving average as wide as the step: a simple anti-alias filter, fine for speech models
        let w = ratio.ceil() as usize;
        let mut acc = 0f32;
        let mut out = Vec::with_capacity(pcm.samples.len());
        for (i, s) in pcm.samples.iter().enumerate() {
            acc += s;
            if i >= w {
                acc -= pcm.samples[i - w];
            }
            out.push(acc / w.min(i + 1) as f32);
        }
        out
    } else {
        pcm.samples.clone()
    };
    let n = (src.len() as f64 / ratio).floor() as usize;
    (0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let k = p.floor() as usize;
            let f = (p - k as f64) as f32;
            let a = src[k.min(src.len() - 1)];
            let b = src[(k + 1).min(src.len() - 1)];
            a + (b - a) * f
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / rate as f32).sin()).collect()
    }

    #[test]
    fn silence_is_trimmed_and_level_evened() {
        let rate = 48000;
        let mut s = vec![0.0001f32; rate as usize]; // 1 s of near-silence
        s.extend(tone(rate, 1.0, 0.02)); // a quiet voice
        s.extend(vec![0.0001f32; rate as usize]);
        let out = clean(Pcm { samples: s, rate }).unwrap();
        assert!((out.seconds() - 1.4).abs() < 0.1, "{}", out.seconds());
        let peak = out.samples.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.1 && peak <= 0.95, "{peak}");
    }

    #[test]
    fn silence_only_is_nothing() {
        assert!(clean(Pcm { samples: vec![0.0; 48000], rate: 48000 }).is_none());
    }

    #[test]
    fn resampling_keeps_the_length() {
        let pcm = Pcm { samples: tone(48000, 2.0, 0.5), rate: 48000 };
        assert_eq!(resample(&pcm, 16000).len(), 32000);
    }

    #[test]
    fn wav_round_trip() {
        let dir = std::env::temp_dir().join("parrot-wav-test.wav");
        write_wav(&dir, &Pcm { samples: tone(16000, 0.5, 0.5), rate: 16000 }).unwrap();
        let back = read_wav(&std::fs::read(&dir).unwrap()).unwrap();
        assert_eq!((back.rate, back.samples.len()), (16000, 8000));
    }
}
