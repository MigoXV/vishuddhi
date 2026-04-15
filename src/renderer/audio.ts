import { MAX_FRONTEND_SAMPLE_RATE } from "../shared/constants";

export interface WaveformLevel {
  min: Float32Array;
  max: Float32Array;
  samplesPerBin: number;
}

export interface DecodedWaveform {
  workerChannelData: Int8Array[];
  waveformLevels: WaveformLevel[][];
  sampleRate: number;
  durationSec: number;
}

const audioContexts = new Map<number, AudioContext>();
const WAVEFORM_BASE_SAMPLES_PER_BIN = 32;

function getAudioContext(sampleRate: number): AudioContext {
  let audioContext = audioContexts.get(sampleRate);
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate });
    audioContexts.set(sampleRate, audioContext);
  }

  return audioContext;
}

function buildWaveformLevels(channelData: Float32Array): WaveformLevel[] {
  const levels: WaveformLevel[] = [];
  let samplesPerBin = WAVEFORM_BASE_SAMPLES_PER_BIN;
  let previousLevel: WaveformLevel | null = null;

  while (true) {
    const level = previousLevel
      ? buildNextWaveformLevel(previousLevel)
      : buildBaseWaveformLevel(channelData, samplesPerBin);
    levels.push(level);

    if (level.min.length <= 2048) {
      break;
    }

    previousLevel = level;
    samplesPerBin *= 2;
  }

  return levels;
}

function buildBaseWaveformLevel(
  channelData: Float32Array,
  samplesPerBin: number,
): WaveformLevel {
  const binCount = Math.ceil(channelData.length / samplesPerBin);
  const min = new Float32Array(binCount);
  const max = new Float32Array(binCount);

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    const start = binIndex * samplesPerBin;
    const end = Math.min(start + samplesPerBin, channelData.length);
    let nextMin = 1;
    let nextMax = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = channelData[sampleIndex];
      if (value < nextMin) {
        nextMin = value;
      }
      if (value > nextMax) {
        nextMax = value;
      }
    }

    min[binIndex] = nextMin;
    max[binIndex] = nextMax;
  }

  return { min, max, samplesPerBin };
}

function buildNextWaveformLevel(previousLevel: WaveformLevel): WaveformLevel {
  const nextLength = Math.ceil(previousLevel.min.length / 2);
  const min = new Float32Array(nextLength);
  const max = new Float32Array(nextLength);

  for (let index = 0; index < nextLength; index += 1) {
    const left = index * 2;
    const right = Math.min(left + 1, previousLevel.min.length - 1);
    min[index] = Math.min(previousLevel.min[left], previousLevel.min[right]);
    max[index] = Math.max(previousLevel.max[left], previousLevel.max[right]);
  }

  return {
    min,
    max,
    samplesPerBin: previousLevel.samplesPerBin * 2,
  };
}

function quantizeChannelData(channelData: Float32Array): Int8Array {
  const quantized = new Int8Array(channelData.length);

  for (let index = 0; index < channelData.length; index += 1) {
    quantized[index] = Math.round(
      Math.max(-1, Math.min(1, channelData[index])) * 127,
    );
  }

  return quantized;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export async function hydrateAudio(
  url: string,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<{
  arrayBuffer: ArrayBuffer;
  blobUrl: string;
  waveform: DecodedWaveform;
}> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (signal?.aborted) {
    throw abortError();
  }

  const targetSampleRate = Math.min(sampleRate, MAX_FRONTEND_SAMPLE_RATE);
  const audioBuffer = await getAudioContext(targetSampleRate).decodeAudioData(
    arrayBuffer.slice(0),
  );
  if (signal?.aborted) {
    throw abortError();
  }

  const decodedChannelData = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => new Float32Array(audioBuffer.getChannelData(index)),
  );
  const workerChannelData = decodedChannelData.map((channelData) =>
    quantizeChannelData(channelData),
  );
  const waveformLevels = decodedChannelData.map((channelData) =>
    buildWaveformLevels(channelData),
  );
  const blob = new Blob([arrayBuffer], { type: "audio/wav" });

  return {
    arrayBuffer,
    blobUrl: URL.createObjectURL(blob),
    waveform: {
      workerChannelData,
      waveformLevels,
      sampleRate: audioBuffer.sampleRate,
      durationSec: audioBuffer.duration,
    },
  };
}
