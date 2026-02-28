/**
 * AudioWorklet processor for extracting PCM audio from MediaStream.
 * Resamples from any input rate to 16kHz for transcription services.
 * Input rate varies by hardware: 48kHz (USB/built-in), 24kHz (Bluetooth SCO), 44.1kHz, etc.
 */
class PCMExtractorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.inputSampleRate = 48000;
    this.bufferSize = Math.floor(this.targetSampleRate * 0.05); // 800 samples = 50ms
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this.resampleRatio = 1;
    this.filterState = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === 'init') {
        this.inputSampleRate = event.data.sampleRate || 48000;
        this.resampleRatio = this.inputSampleRate / this.targetSampleRate;
      }
    };
  }

  lowPassFilter(samples, cutoffHz, sampleRate) {
    const rc = 1.0 / (2.0 * Math.PI * cutoffHz);
    const dt = 1.0 / sampleRate;
    const alpha = dt / (rc + dt);
    const output = new Float32Array(samples.length);
    let prev = this.filterState || 0;
    for (let i = 0; i < samples.length; i++) {
      prev = prev + alpha * (samples[i] - prev);
      output[i] = prev;
    }
    this.filterState = prev;
    return output;
  }

  resample(inputSamples) {
    // Anti-alias filter: cutoff at 80% of target Nyquist (0.8 * 8kHz = 6.4kHz for 16kHz target),
    // but never above 80% of input Nyquist for very low input rates.
    const targetNyquist = this.targetSampleRate / 2;
    const inputNyquist = this.inputSampleRate / 2;
    const cutoff = Math.min(targetNyquist * 0.8, inputNyquist * 0.8);
    const filtered = this.lowPassFilter(inputSamples, cutoff, this.inputSampleRate);
    const outputLength = Math.floor(filtered.length / this.resampleRatio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * this.resampleRatio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, filtered.length - 1);
      const fraction = srcIndex - srcIndexFloor;
      output[i] = filtered[srcIndexFloor] * (1 - fraction) + filtered[srcIndexCeil] * fraction;
    }
    return output;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelData = input[0];
    if (!channelData || channelData.length === 0) return true;

    const resampled = this.resample(channelData);

    for (let i = 0; i < resampled.length; i++) {
      this.buffer[this.bufferIndex++] = resampled[i];

      if (this.bufferIndex >= this.bufferSize) {
        const pcmFloat32 = new Float32Array(this.buffer);
        this.port.postMessage({
          type: 'pcm',
          samples: pcmFloat32.buffer,
          sampleRate: this.targetSampleRate,
          timestamp: currentTime,
        }, [pcmFloat32.buffer]);

        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-extractor', PCMExtractorProcessor);
