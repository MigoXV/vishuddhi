import path from "node:path";
import { mkdir, open } from "node:fs/promises";

import type {
  AppSettings,
  BatchJobStatus,
  RunDenoiseOptions,
  RunDenoiseResult,
  SourceEntry,
} from "@shared/contracts";
import { DENOISE_SEGMENT_DURATION_SEC } from "@shared/constants";

import {
  deriveResultPath,
  flattenEntries,
  readSourcePcmAudio,
  scanWorkspace,
} from "./audio-source";
import { denoiseAudio } from "./grpc";
import { createWavHeader, readWavMetadata } from "./wav";

const PCM_BYTES_PER_SAMPLE = 2;

function getSegmentByteLength(sampleRate: number): number {
  return sampleRate * PCM_BYTES_PER_SAMPLE * DENOISE_SEGMENT_DURATION_SEC;
}

function normalizeChunkLength(chunk: Buffer, expectedLength: number): Buffer {
  if (chunk.length === expectedLength) {
    return chunk;
  }

  if (chunk.length > expectedLength) {
    return chunk.subarray(0, expectedLength);
  }

  const padded = Buffer.alloc(expectedLength);
  chunk.copy(padded);
  return padded;
}

async function createPartialResultFile(
  resultPath: string,
  audioLength: number,
  sampleRate: number,
) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  const handle = await open(resultPath, "w");
  const header = createWavHeader(audioLength, {
    sampleRate,
    channelCount: 1,
    bitsPerSample: 16,
  });
  await handle.write(header, 0, header.length, 0);
  await handle.truncate(header.length + audioLength);
  return handle;
}

export async function runDenoiseForSource(
  sourcePath: string,
  settings: AppSettings,
  options: RunDenoiseOptions = {},
): Promise<RunDenoiseResult> {
  const resultPath = deriveResultPath(sourcePath);
  if (!options.force) {
    try {
      const existingMeta = await readWavMetadata(resultPath);
      return {
        sourcePath,
        resultPath,
        skipped: true,
        resultAudioMeta: existingMeta,
      };
    } catch {
      // Continue and regenerate the result.
    }
  }

  const { audioData, audioMeta } = await readSourcePcmAudio(sourcePath, settings);
  const resultHandle = await createPartialResultFile(
    resultPath,
    audioData.length,
    audioMeta.sampleRate,
  );
  const segmentByteLength = getSegmentByteLength(audioMeta.sampleRate);

  try {
    for (
      let segmentOffset = 0;
      segmentOffset < audioData.length;
      segmentOffset += segmentByteLength
    ) {
      const segmentEnd = Math.min(segmentOffset + segmentByteLength, audioData.length);
      const segment = audioData.subarray(segmentOffset, segmentEnd);
      const denoisedSegment = await denoiseAudio(
        settings.grpcAddress,
        Buffer.from(segment),
        audioMeta.sampleRate,
      );
      const normalizedSegment = normalizeChunkLength(
        denoisedSegment,
        segment.length,
      );

      await resultHandle.write(
        normalizedSegment,
        0,
        normalizedSegment.length,
        44 + segmentOffset,
      );
    }
  } finally {
    await resultHandle.close();
  }

  return {
    sourcePath,
    resultPath,
    skipped: false,
    resultAudioMeta: await readWavMetadata(resultPath),
  };
}

function matchesTargetDirectory(entry: SourceEntry, targetDirectory: string): boolean {
  const relative = path.relative(targetDirectory, entry.sourcePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function runBatchDenoise(
  rootPath: string,
  targetDirectory: string,
  settings: AppSettings,
  options: RunDenoiseOptions = {},
): Promise<BatchJobStatus> {
  const tree = await scanWorkspace(rootPath, settings);
  const entries = flattenEntries(tree).filter(
    (entry) => entry.denoiseEligibility.supported && matchesTargetDirectory(entry, targetDirectory),
  );

  const status: BatchJobStatus = {
    total: entries.length,
    completed: 0,
    skipped: 0,
    failures: [],
    currentSourcePath: null,
  };

  for (const entry of entries) {
    status.currentSourcePath = entry.sourcePath;
    try {
      const result = await runDenoiseForSource(entry.sourcePath, settings, options);
      if (result.skipped) {
        status.skipped += 1;
      } else {
        status.completed += 1;
      }
    } catch (error) {
      status.failures.push({
        sourcePath: entry.sourcePath,
        message: error instanceof Error ? error.message : "批处理失败。",
      });
    }
  }

  status.currentSourcePath = null;
  return status;
}
