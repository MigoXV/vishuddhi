export type SourceKind = "wav" | "pcm" | "dat";
export type SourceResultStatus = "ready" | "done" | "unsupported";
export type RuntimeEntryStatus =
  | SourceResultStatus
  | "running"
  | "error";
export type FrequencyScale = "linear" | "log";
export type UiThemePreference = "system" | "light" | "dark";

export interface AudioMeta {
  sampleRate: number;
  channelCount: number;
  durationSec: number;
  bitsPerSample: number;
}

export interface DenoiseEligibility {
  supported: boolean;
  reason: string | null;
}

export interface AppSettings {
  grpcAddress: string;
  pcmSampleRate: number;
  datSampleRate: number;
  uiThemePreference: UiThemePreference;
  sourceHotkey: string;
  resultHotkey: string;
}

export interface BootstrapState {
  settings: AppSettings;
  lastWorkspacePath: string | null;
}

export interface SourceEntry {
  sourcePath: string;
  kind: SourceKind;
  stem: string;
  relativeDir: string;
  audioMeta: AudioMeta;
  denoiseEligibility: DenoiseEligibility;
  resultPath: string | null;
  resultStatus: SourceResultStatus;
}

export interface SourceDirectory {
  name: string;
  relativePath: string;
  absolutePath: string;
  directories: SourceDirectory[];
  entries: SourceEntry[];
}

export interface LoadedSourceDocument {
  entry: SourceEntry;
  sourceAudioUrl: string;
  resultAudioUrl: string | null;
  resultAudioMeta: AudioMeta | null;
  resultUpdatedAt: number | null;
  disableReason: string | null;
}

export interface RunDenoiseOptions {
  force?: boolean;
}

export interface RunDenoiseResult {
  sourcePath: string;
  resultPath: string;
  skipped: boolean;
  resultAudioMeta: AudioMeta;
}

export interface BatchJobFailure {
  sourcePath: string;
  message: string;
}

export interface BatchJobStatus {
  total: number;
  completed: number;
  skipped: number;
  failures: BatchJobFailure[];
  currentSourcePath: string | null;
}

export interface HostBridge {
  mode: "electron" | "browser";
  pickDirectory(): Promise<string | null>;
  getBootstrapState(): Promise<BootstrapState>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  testGrpcConnection(grpcAddress: string): Promise<{ ok: boolean; message: string }>;
  scanWorkspace(rootPath: string): Promise<SourceDirectory>;
  loadSource(sourcePath: string): Promise<LoadedSourceDocument>;
  runDenoise(
    sourcePath: string,
    options?: RunDenoiseOptions,
  ): Promise<RunDenoiseResult>;
  runBatch(
    targetDirectory: string,
    options?: RunDenoiseOptions,
  ): Promise<BatchJobStatus>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
}
