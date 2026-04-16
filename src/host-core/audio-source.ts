import path from "node:path";
import { access, constants as fsConstants, readFile, readdir, stat } from "node:fs/promises";

import type {
  AppSettings,
  AudioMeta,
  LoadedSourceDocument,
  SourceDirectory,
  SourceEntry,
  SourceKind,
} from "@shared/contracts";
import { RESULT_SUFFIX } from "@shared/constants";

import { readBytes, readWavFile, readWavMetadata, wrapPcmAsWav } from "./wav";

interface SourceDocumentUrls {
  resolveSourceAudioUrl(sourcePath: string): string;
  resolveResultAudioUrl(sourcePath: string, stamp: number): string;
}

function normalizeRelativeDir(relativeDir: string): string {
  return relativeDir === "" ? "." : relativeDir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function getSourceKind(filePath: string): SourceKind | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") {
    return "wav";
  }
  if (extension === ".pcm") {
    return "pcm";
  }
  if (extension === ".dat") {
    return "dat";
  }

  return null;
}

export function deriveResultPath(sourcePath: string): string {
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(directory, `${stem}${RESULT_SUFFIX}`);
}

export function getRawSampleRate(
  kind: Extract<SourceKind, "pcm" | "dat">,
  settings: AppSettings,
): number {
  return kind === "pcm" ? settings.pcmSampleRate : settings.datSampleRate;
}

export async function readRawAudioMeta(
  filePath: string,
  sampleRate: number,
): Promise<AudioMeta> {
  const bytes = await readFile(filePath);
  return {
    sampleRate,
    channelCount: 1,
    durationSec: bytes.length / 2 / sampleRate,
    bitsPerSample: 16,
  };
}

async function readAudioMeta(
  filePath: string,
  kind: SourceKind,
  settings: AppSettings,
): Promise<AudioMeta> {
  if (kind === "wav") {
    return readWavMetadata(filePath);
  }

  return readRawAudioMeta(filePath, getRawSampleRate(kind, settings));
}

function createUnavailableAudioMeta(kind: SourceKind, settings: AppSettings): AudioMeta {
  return {
    sampleRate: kind === "wav" ? 0 : getRawSampleRate(kind, settings),
    channelCount: 0,
    durationSec: 0,
    bitsPerSample: kind === "wav" ? 0 : 16,
  };
}

export async function analyzeSourceFile(
  filePath: string,
  rootPath: string,
  settings: AppSettings,
): Promise<SourceEntry | null> {
  const kind = getSourceKind(filePath);
  if (!kind) {
    return null;
  }

  if (filePath.toLowerCase().endsWith(RESULT_SUFFIX)) {
    return null;
  }

  const relativeDir = normalizeRelativeDir(path.relative(rootPath, path.dirname(filePath)));
  const resultPath = deriveResultPath(filePath);
  const hasResult = await fileExists(resultPath);
  let audioMeta: AudioMeta;
  let supported: boolean;
  let reason: string | null;

  try {
    audioMeta = await readAudioMeta(filePath, kind, settings);
    supported = true;
    reason = null;

    if (
      kind === "wav" &&
      (audioMeta.channelCount !== 1 || audioMeta.bitsPerSample !== 16)
    ) {
      supported = false;
      reason = "仅支持单声道 16-bit PCM WAV 送入降噪引擎。";
    }
  } catch (error) {
    audioMeta = createUnavailableAudioMeta(kind, settings);
    supported = false;
    reason = error instanceof Error ? error.message : "读取音频元信息失败。";
  }

  return {
    sourcePath: filePath,
    kind,
    stem: path.basename(filePath, path.extname(filePath)),
    relativeDir,
    audioMeta,
    denoiseEligibility: {
      supported,
      reason,
    },
    resultPath: hasResult ? resultPath : null,
    resultStatus: supported ? (hasResult ? "done" : "ready") : "unsupported",
  };
}

function sortEntries(entries: SourceEntry[]): SourceEntry[] {
  return [...entries].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function sortDirectories(directories: SourceDirectory[]): SourceDirectory[] {
  return [...directories].sort((left, right) => left.name.localeCompare(right.name));
}

async function buildDirectoryTree(
  rootPath: string,
  currentPath: string,
  settings: AppSettings,
): Promise<SourceDirectory | null> {
  let children;
  try {
    children = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: SourceDirectory[] = [];
  const entries: SourceEntry[] = [];

  for (const child of children) {
    const absolutePath = path.join(currentPath, child.name);
    if (child.isDirectory()) {
      const nested = await buildDirectoryTree(rootPath, absolutePath, settings);
      if (nested) {
        directories.push(nested);
      }
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    let analyzed: SourceEntry | null = null;
    try {
      analyzed = await analyzeSourceFile(absolutePath, rootPath, settings);
    } catch {
      analyzed = null;
    }
    if (analyzed) {
      entries.push(analyzed);
    }
  }

  const sortedEntries = sortEntries(entries);
  const sortedDirectories = sortDirectories(directories);

  if (sortedEntries.length === 0 && sortedDirectories.length === 0) {
    return null;
  }

  return {
    name: path.basename(currentPath),
    relativePath: path.relative(rootPath, currentPath),
    absolutePath: currentPath,
    directories: sortedDirectories,
    entries: sortedEntries,
  };
}

export async function scanWorkspace(
  rootPath: string,
  settings: AppSettings,
): Promise<SourceDirectory> {
  const tree = await buildDirectoryTree(rootPath, rootPath, settings);
  if (!tree) {
    return {
      name: path.basename(rootPath),
      relativePath: "",
      absolutePath: rootPath,
      directories: [],
      entries: [],
    };
  }

  return {
    ...tree,
    relativePath: "",
    absolutePath: rootPath,
  };
}

export async function readSourcePcmAudio(
  sourcePath: string,
  settings: AppSettings,
): Promise<{ audioData: Buffer; audioMeta: AudioMeta; kind: SourceKind }> {
  const kind = getSourceKind(sourcePath);
  if (!kind) {
    throw new Error(`Unsupported source file: ${sourcePath}`);
  }

  if (kind === "wav") {
    const parsed = await readWavFile(sourcePath, true);
    if (
      parsed.formatCode !== 1 ||
      parsed.meta.channelCount !== 1 ||
      parsed.meta.bitsPerSample !== 16 ||
      !parsed.audioData
    ) {
      throw new Error("仅支持单声道 16-bit PCM WAV 送入降噪引擎。");
    }

    return {
      audioData: parsed.audioData,
      audioMeta: parsed.meta,
      kind,
    };
  }

  const sampleRate = getRawSampleRate(kind, settings);
  return {
    audioData: await readBytes(sourcePath),
    audioMeta: await readRawAudioMeta(sourcePath, sampleRate),
    kind,
  };
}

export async function buildPreviewWav(
  sourcePath: string,
  settings: AppSettings,
): Promise<Buffer> {
  const kind = getSourceKind(sourcePath);
  if (!kind) {
    throw new Error(`Unsupported source file: ${sourcePath}`);
  }

  if (kind === "wav") {
    return readBytes(sourcePath);
  }

  const sampleRate = getRawSampleRate(kind, settings);
  const bytes = await readBytes(sourcePath);
  return wrapPcmAsWav(bytes, {
    sampleRate,
    channelCount: 1,
    bitsPerSample: 16,
  });
}

export async function loadSourceDocument(
  sourcePath: string,
  settings: AppSettings,
  urls: SourceDocumentUrls,
): Promise<LoadedSourceDocument> {
  const entry = await analyzeSourceFile(sourcePath, path.dirname(sourcePath), settings);
  if (!entry) {
    throw new Error(`Unsupported source file: ${sourcePath}`);
  }

  const resolvedEntry = {
    ...entry,
    relativeDir: normalizeRelativeDir(path.dirname(sourcePath)),
  };
  const resultPath = deriveResultPath(sourcePath);
  const resultExists = await fileExists(resultPath);
  const resultUpdatedAt = resultExists ? (await stat(resultPath)).mtimeMs : null;

  return {
    entry: {
      ...resolvedEntry,
      resultPath: resultExists ? resultPath : null,
      resultStatus: resolvedEntry.denoiseEligibility.supported
        ? resultExists
          ? "done"
          : "ready"
        : "unsupported",
    },
    sourceAudioUrl: urls.resolveSourceAudioUrl(sourcePath),
    resultAudioUrl:
      resultExists && resultUpdatedAt !== null
        ? urls.resolveResultAudioUrl(sourcePath, resultUpdatedAt)
        : null,
    resultAudioMeta: resultExists ? await readWavMetadata(resultPath) : null,
    resultUpdatedAt,
    disableReason: resolvedEntry.denoiseEligibility.reason,
  };
}

export function flattenEntries(tree: SourceDirectory): SourceEntry[] {
  return [
    ...tree.entries,
    ...tree.directories.flatMap((directory) => flattenEntries(directory)),
  ];
}
