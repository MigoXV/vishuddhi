import { open, readFile } from "node:fs/promises";

import type { AudioMeta } from "../shared/contracts";

export interface ParsedWavFile {
  meta: AudioMeta;
  formatCode: number;
  dataOffset: number;
  dataSize: number;
  audioData?: Buffer;
}

function readAscii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString("ascii", start, end);
}

async function parseWavFile(
  filePath: string,
  includeAudioData: boolean,
): Promise<ParsedWavFile> {
  const handle = await open(filePath, "r");

  try {
    const riffHeader = Buffer.alloc(12);
    await handle.read(riffHeader, 0, riffHeader.length, 0);

    if (
      readAscii(riffHeader, 0, 4) !== "RIFF" ||
      readAscii(riffHeader, 8, 12) !== "WAVE"
    ) {
      throw new Error(`Unsupported WAV file: ${filePath}`);
    }

    let cursor = 12;
    let sampleRate = 0;
    let channelCount = 0;
    let bitsPerSample = 0;
    let byteRate = 0;
    let formatCode = 0;
    let dataOffset = 0;
    let dataSize = 0;

    while (true) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, header.length, cursor);
      if (bytesRead < 8) {
        break;
      }

      const chunkId = readAscii(header, 0, 4);
      const chunkSize = header.readUInt32LE(4);
      cursor += 8;

      if (chunkId === "fmt ") {
        const fmtBuffer = Buffer.alloc(Math.min(chunkSize, 32));
        await handle.read(fmtBuffer, 0, fmtBuffer.length, cursor);
        formatCode = fmtBuffer.readUInt16LE(0);
        channelCount = fmtBuffer.readUInt16LE(2);
        sampleRate = fmtBuffer.readUInt32LE(4);
        byteRate = fmtBuffer.readUInt32LE(8);
        bitsPerSample = fmtBuffer.readUInt16LE(14);
      }

      if (chunkId === "data") {
        dataOffset = cursor;
        dataSize = chunkSize;
        if (sampleRate > 0 && channelCount > 0 && bitsPerSample > 0) {
          break;
        }
      }

      cursor += chunkSize + (chunkSize % 2);
    }

    if (
      sampleRate <= 0 ||
      channelCount <= 0 ||
      byteRate <= 0 ||
      bitsPerSample <= 0 ||
      dataOffset <= 0 ||
      dataSize <= 0
    ) {
      throw new Error(`Incomplete WAV metadata: ${filePath}`);
    }

    const result: ParsedWavFile = {
      meta: {
        sampleRate,
        channelCount,
        durationSec: dataSize / byteRate,
        bitsPerSample,
      },
      formatCode,
      dataOffset,
      dataSize,
    };

    if (includeAudioData) {
      const audioData = Buffer.alloc(dataSize);
      await handle.read(audioData, 0, audioData.length, dataOffset);
      result.audioData = audioData;
    }

    return result;
  } finally {
    await handle.close();
  }
}

export async function readWavMetadata(filePath: string): Promise<AudioMeta> {
  return (await parseWavFile(filePath, false)).meta;
}

export async function readWavFile(
  filePath: string,
  includeAudioData = true,
): Promise<ParsedWavFile> {
  return parseWavFile(filePath, includeAudioData);
}

export function createWavHeader(
  dataLength: number,
  options: {
    sampleRate: number;
    channelCount: number;
    bitsPerSample: number;
  },
): Buffer {
  const byteRate =
    options.sampleRate * options.channelCount * (options.bitsPerSample / 8);
  const blockAlign = options.channelCount * (options.bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(options.channelCount, 22);
  header.writeUInt32LE(options.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(options.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  return header;
}

export function wrapPcmAsWav(
  audioData: Buffer | Uint8Array,
  options: {
    sampleRate: number;
    channelCount: number;
    bitsPerSample: number;
  },
): Buffer {
  const bytes =
    audioData instanceof Buffer ? audioData : Buffer.from(audioData.buffer);
  const header = createWavHeader(bytes.length, options);

  return Buffer.concat([header, bytes]);
}

export async function readBytes(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
