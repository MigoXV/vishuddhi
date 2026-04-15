import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type {
  AppSettings,
  LoadedSourceDocument,
  RuntimeEntryStatus,
  SourceDirectory,
  SourceEntry,
} from "@shared/contracts";
import {
  DEFAULT_TIME_WINDOW_SEC,
  DEFAULT_GRPC_ADDRESS,
  DEFAULT_RAW_SAMPLE_RATE,
  DEFAULT_RESULT_HOTKEY,
  DEFAULT_SOURCE_HOTKEY,
  MIN_TIME_WINDOW_SEC,
} from "@shared/constants";
import { clamp } from "@shared/math";

import { hydrateAudio } from "./audio";
import { getHostBridge } from "./bridge";
import { SettingsDialog } from "./SettingsDialog";
import {
  SpectrogramPane,
  type SpectrogramDocument,
  type TimeRange,
} from "./SpectrogramPane";
import { ThemeSwitch } from "./ThemeSwitch";
import {
  buildUiThemeStyle,
  resolveUiThemeMode,
  useSystemTheme,
} from "./theme";
import {
  collectDirectoryPaths,
  filterDirectoryTree,
  findDirectoryByRelativePath,
  flattenEntries,
  formatFriendlyStem,
  formatDuration,
  formatKindLabel,
  formatSampleRate,
  getStatusLabel,
  resolveEntryStatus,
  type EntryFilter,
  type EntryOverride,
} from "./model";
import { SpectrogramWorkerClient } from "./worker-client";

interface HydratedTrack {
  document: SpectrogramDocument;
  blobUrl: string;
  workerChannelData: Int8Array[];
}

interface BatchState {
  isRunning: boolean;
  label: string;
  total: number;
  completed: number;
  skipped: number;
  failures: Array<{ sourcePath: string; message: string }>;
  currentSourcePath: string | null;
}

type PlaybackMode = "source" | "result" | "ab";

const DENOISE_RESULT_POLL_INTERVAL_MS = 1_000;

const DEFAULT_SETTINGS: AppSettings = {
  grpcAddress: DEFAULT_GRPC_ADDRESS,
  pcmSampleRate: DEFAULT_RAW_SAMPLE_RATE,
  datSampleRate: DEFAULT_RAW_SAMPLE_RATE,
  uiThemePreference: "system",
  sourceHotkey: DEFAULT_SOURCE_HOTKEY,
  resultHotkey: DEFAULT_RESULT_HOTKEY,
};

const FILTER_OPTIONS: EntryFilter[] = [
  "all",
  "ready",
  "done",
  "unsupported",
  "running",
  "error",
];

function findFirstEntry(tree: SourceDirectory): SourceEntry | null {
  if (tree.entries.length > 0) {
    return tree.entries[0];
  }

  for (const child of tree.directories) {
    const match = findFirstEntry(child);
    if (match) {
      return match;
    }
  }

  return null;
}

function createInitialViewport(durationSec: number): TimeRange {
  const span = Math.min(durationSec, DEFAULT_TIME_WINDOW_SEC);
  return {
    startSec: 0,
    endSec: Math.max(span, 1e-3),
  };
}

function getViewportSpan(viewport: TimeRange): number {
  return Math.max(viewport.endSec - viewport.startSec, MIN_TIME_WINDOW_SEC);
}

function clampViewportToDuration(
  durationSec: number,
  startSec: number,
  spanSec: number,
): TimeRange {
  const safeDuration = Math.max(durationSec, MIN_TIME_WINDOW_SEC);
  const clampedSpan = clamp(spanSec, MIN_TIME_WINDOW_SEC, safeDuration);
  const maxStart = Math.max(safeDuration - clampedSpan, 0);
  const nextStart = clamp(startSec, 0, maxStart);
  return {
    startSec: nextStart,
    endSec: nextStart + clampedSpan,
  };
}

function followViewportWithPlayhead(
  viewport: TimeRange,
  timeSec: number,
  durationSec: number,
): TimeRange {
  const spanSec = getViewportSpan(viewport);
  const leftAnchor = 0.12;
  const rightAnchor = 0.88;
  const leftThreshold = viewport.startSec + spanSec * leftAnchor;
  const rightThreshold = viewport.startSec + spanSec * rightAnchor;

  if (timeSec > rightThreshold) {
    return clampViewportToDuration(
      durationSec,
      timeSec - spanSec * rightAnchor,
      spanSec,
    );
  }

  if (timeSec < leftThreshold) {
    return clampViewportToDuration(
      durationSec,
      timeSec - spanSec * leftAnchor,
      spanSec,
    );
  }

  return viewport;
}

function formatRuntimeStatus(status: RuntimeEntryStatus): string {
  return getStatusLabel(status);
}

function countStatuses(
  tree: SourceDirectory | null,
  overrides: Map<string, EntryOverride>,
): Record<EntryFilter, number> {
  const counts: Record<EntryFilter, number> = {
    all: 0,
    ready: 0,
    done: 0,
    unsupported: 0,
    running: 0,
    error: 0,
  };

  if (!tree) {
    return counts;
  }

  for (const entry of flattenEntries(tree)) {
    const status = resolveEntryStatus(entry, overrides.get(entry.sourcePath));
    counts.all += 1;
    counts[status as EntryFilter] += 1;
  }

  return counts;
}

function getDirectoryEntryCount(directory: SourceDirectory): number {
  return flattenEntries(directory).length;
}

function getResultAvailabilityLabel(entry: SourceEntry): string {
  if (!entry.denoiseEligibility.supported) {
    return "结果不可用";
  }

  return entry.resultPath ? "结果可用" : "结果不可用";
}

function getEntrySourceLabel(entry: SourceEntry): string {
  return entry.relativeDir === "." ? "工作区根目录" : entry.relativeDir;
}

function getPrimaryActionLabel(entry: SourceEntry): string {
  return entry.resultPath ? "打开结果" : "运行降噪";
}

function getPrimaryActionDisabled(
  entry: SourceEntry,
  isRunningSelected: boolean,
  isBatchRunning: boolean,
): boolean {
  if (isRunningSelected || isBatchRunning) {
    return true;
  }

  if (entry.resultPath) {
    return false;
  }

  return !entry.denoiseEligibility.supported;
}

function buildSummaryLine(entry: SourceEntry): string {
  return [
    formatKindLabel(entry.kind),
    formatSampleRate(entry.audioMeta.sampleRate),
    formatDuration(entry.audioMeta.durationSec),
  ].join(" · ");
}


export function App() {
  const hostBridge = getHostBridge();
  const workerClientRef = useRef<SpectrogramWorkerClient | null>(null);
  const sourceTrackRef = useRef<HydratedTrack | null>(null);
  const resultTrackRef = useRef<HydratedTrack | null>(null);
  const sourceAudioRef = useRef<HTMLAudioElement | null>(null);
  const resultAudioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(true);
  const selectedSourcePathRef = useRef<string | null>(null);
  const playbackSnapshotRef = useRef({
    currentTime: 0,
    isPlaying: false,
    activePlayback: "source" as "source" | "result",
  });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [workspaceTree, setWorkspaceTree] = useState<SourceDirectory | null>(null);
  const [selectedSourcePath, setSelectedSourcePath] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [entryFilter, setEntryFilter] = useState<EntryFilter>("all");
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set([""]));
  const [entryOverrides, setEntryOverrides] = useState<Map<string, EntryOverride>>(new Map());
  const [loadedDocument, setLoadedDocument] = useState<LoadedSourceDocument | null>(null);
  const [sourceTrack, setSourceTrack] = useState<HydratedTrack | null>(null);
  const [resultTrack, setResultTrack] = useState<HydratedTrack | null>(null);
  const [viewport, setViewport] = useState<TimeRange>({ startSec: 0, endSec: 1 });
  const [currentTime, setCurrentTime] = useState(0);
  const [activePlayback, setActivePlayback] = useState<"source" | "result">("source");
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("source");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTesting, setSettingsTesting] = useState(false);
  const [settingsTestResult, setSettingsTestResult] = useState<string | null>(null);
  const [isRunningSelected, setIsRunningSelected] = useState(false);
  const [batchState, setBatchState] = useState<BatchState | null>(null);
  const [forceBatch, setForceBatch] = useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const systemTheme = useSystemTheme();

  if (!workerClientRef.current) {
    workerClientRef.current = new SpectrogramWorkerClient();
  }

  const workerClient = workerClientRef.current;
  const resolvedThemeMode = resolveUiThemeMode(
    settings.uiThemePreference,
    systemTheme,
  );
  const themeStyle = buildUiThemeStyle(resolvedThemeMode);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    selectedSourcePathRef.current = selectedSourcePath;
  }, [selectedSourcePath]);

  useEffect(() => {
    playbackSnapshotRef.current = {
      currentTime,
      isPlaying,
      activePlayback,
    };
  }, [activePlayback, currentTime, isPlaying]);

  useEffect(() => {
    setIsFileMenuOpen(false);
    setIsHelpOpen(false);
    setCopyFeedback(null);
  }, [selectedSourcePath]);

  useEffect(() => {
    return () => {
      pausePlayback(sourceAudioRef, resultAudioRef, setIsPlaying);
      disposeTrack(workerClient, sourceTrackRef.current);
      disposeTrack(workerClient, resultTrackRef.current);
      workerClient.dispose();
    };
  }, [workerClient]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const bootstrap = await hostBridge.getBootstrapState();
        if (isCancelled) {
          return;
        }
        setSettings(bootstrap.settings);
        if (bootstrap.lastWorkspacePath) {
          await refreshWorkspace(bootstrap.lastWorkspacePath, null, true);
        }
      } catch (error) {
        if (isCancelled) {
          return;
        }
        setWorkspaceError(
          error instanceof Error ? error.message : "启动时读取工作区失败。",
        );
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedSourcePath) {
      setLoadedDocument(null);
      setDocumentError(null);
      return;
    }

    let isCancelled = false;
    setDocumentError(null);
    pausePlayback(sourceAudioRef, resultAudioRef, setIsPlaying);

    void (async () => {
      try {
        const document = await hostBridge.loadSource(selectedSourcePath);
        if (!isCancelled) {
          setLoadedDocument(document);
        }
      } catch (error) {
        if (!isCancelled) {
          setDocumentError(
            error instanceof Error ? error.message : "加载文件失败。",
          );
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [hostBridge, selectedSourcePath]);

  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();

    disposeTrack(workerClient, sourceTrackRef.current);
    sourceTrackRef.current = null;
    setSourceTrack(null);
    setCurrentTime(0);
    pausePlayback(sourceAudioRef, resultAudioRef, setIsPlaying);

    if (!loadedDocument) {
      return () => {
        abortController.abort();
      };
    }

    void (async () => {
      try {
        const nextSourceTrack = await hydrateTrack(
          workerClient,
          loadedDocument.sourceAudioUrl,
          `source:${loadedDocument.entry.sourcePath}`,
          loadedDocument.entry.audioMeta.sampleRate,
          abortController.signal,
        );
        if (isCancelled) {
          disposeTrack(workerClient, nextSourceTrack);
          return;
        }

        sourceTrackRef.current = nextSourceTrack;
        setSourceTrack(nextSourceTrack);
        setViewport(createInitialViewport(nextSourceTrack.document.durationSec));
      } catch (error) {
        if (!isCancelled) {
          setDocumentError(
            error instanceof Error ? error.message : "音频解码失败。",
          );
        }
      }
    })();

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [
    loadedDocument?.entry.sourcePath,
    loadedDocument?.sourceAudioUrl,
    loadedDocument?.entry.audioMeta.sampleRate,
    workerClient,
  ]);

  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();
    const previousTrack = resultTrackRef.current;
    const previousResultAudio = resultAudioRef.current;
    const { activePlayback, currentTime, isPlaying } = playbackSnapshotRef.current;
    const shouldResumeResult = activePlayback === "result" && isPlaying;
    const resumeTime = shouldResumeResult
      ? previousResultAudio?.currentTime ?? currentTime
      : currentTime;

    if (!loadedDocument?.resultAudioUrl) {
      disposeTrack(workerClient, previousTrack);
      resultTrackRef.current = null;
      setResultTrack(null);
      return () => {
        abortController.abort();
      };
    }

    void (async () => {
      try {
        const nextResultTrack = await hydrateTrack(
          workerClient,
          loadedDocument.resultAudioUrl,
          `result:${loadedDocument.entry.sourcePath}`,
          loadedDocument.resultAudioMeta?.sampleRate ??
            loadedDocument.entry.audioMeta.sampleRate,
          abortController.signal,
        );

        if (isCancelled) {
          disposeTrack(workerClient, nextResultTrack);
          return;
        }

        disposeTrack(workerClient, previousTrack);
        resultTrackRef.current = nextResultTrack;
        setResultTrack(nextResultTrack);

        if (shouldResumeResult) {
          const resultAudio = resultAudioRef.current;
          if (resultAudio) {
            resultAudio.currentTime = resumeTime;
            await resultAudio.play().catch(() => undefined);
            if (!isCancelled) {
              setIsPlaying(true);
            }
          }
        }
      } catch (error) {
        if (!isCancelled) {
          setDocumentError(
            error instanceof Error ? error.message : "结果音频解码失败。",
          );
        }
      }
    })();

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [
    loadedDocument?.entry.sourcePath,
    loadedDocument?.resultAudioUrl,
    loadedDocument?.resultUpdatedAt,
    loadedDocument?.resultAudioMeta?.sampleRate,
    loadedDocument?.entry.audioMeta.sampleRate,
    workerClient,
  ]);

  useEffect(() => {
    syncAudioElements(sourceAudioRef.current, resultAudioRef.current, currentTime);
  }, [currentTime]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLButtonElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        void toggleCurrentPlayback();
        return;
      }

      if (event.key.toLowerCase() === settings.sourceHotkey) {
        event.preventDefault();
        void selectPlaybackTarget("source");
        return;
      }

      if (event.key.toLowerCase() === settings.resultHotkey) {
        event.preventDefault();
        void selectPlaybackTarget("result");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activePlayback,
    isPlaying,
    playbackMode,
    resultTrack,
    settings.resultHotkey,
    settings.sourceHotkey,
    sourceTrack,
  ]);

  useEffect(() => {
    if (!resultTrack) {
      if (activePlayback === "result") {
        setActivePlayback("source");
      }
      if (playbackMode === "result" || playbackMode === "ab") {
        setPlaybackMode("source");
      }
    }
  }, [activePlayback, playbackMode, resultTrack]);

  useEffect(() => {
    if (!isFileMenuOpen && !isHelpOpen) {
      return;
    }

    function handleWindowPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(".floating-menu, .floating-toggle, .help-popover")
      ) {
        return;
      }

      setIsFileMenuOpen(false);
      setIsHelpOpen(false);
    }

    window.addEventListener("pointerdown", handleWindowPointerDown);
    return () => window.removeEventListener("pointerdown", handleWindowPointerDown);
  }, [isFileMenuOpen, isHelpOpen]);

  const filteredTree = useMemo(() => {
    if (!workspaceTree) {
      return null;
    }

    return filterDirectoryTree(workspaceTree, searchTerm, entryFilter, entryOverrides);
  }, [entryFilter, entryOverrides, searchTerm, workspaceTree]);

  const statusCounts = useMemo(
    () => countStatuses(workspaceTree, entryOverrides),
    [entryOverrides, workspaceTree],
  );

  const selectedEntry = useMemo(() => {
    if (!workspaceTree || !selectedSourcePath) {
      return null;
    }

    return flattenEntries(workspaceTree).find(
      (entry) => entry.sourcePath === selectedSourcePath,
    ) ?? null;
  }, [selectedSourcePath, workspaceTree]);

  const selectedStatus = selectedEntry
    ? resolveEntryStatus(selectedEntry, entryOverrides.get(selectedEntry.sourcePath))
    : null;
  const friendlyStem = selectedEntry ? formatFriendlyStem(selectedEntry.stem) : "";
  const truncatedSourcePath = selectedEntry
    ? formatFriendlyStem(selectedEntry.sourcePath, 56)
    : "";

  async function refreshWorkspace(
    rootPath: string,
    preferredSelection: string | null = selectedSourcePath,
    preserveExpansion = false,
  ): Promise<void> {
    setWorkspaceError(null);
    setIsWorkspaceLoading(true);
    try {
      const nextTree = await hostBridge.scanWorkspace(rootPath);
      if (!mountedRef.current) {
        return;
      }
      setWorkspaceTree(nextTree);
      setWorkspaceRoot(rootPath);
      if (!preserveExpansion) {
        setExpandedDirectories(new Set(collectDirectoryPaths(nextTree)));
      }

      const nextSelectedEntry =
        (preferredSelection &&
          flattenEntries(nextTree).find((entry) => entry.sourcePath === preferredSelection)) ??
        findFirstEntry(nextTree);
      setSelectedSourcePath(nextSelectedEntry?.sourcePath ?? null);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setWorkspaceError(
        error instanceof Error ? error.message : "扫描工作区失败。",
      );
    } finally {
      if (mountedRef.current) {
        setIsWorkspaceLoading(false);
      }
    }
  }

  async function handlePickDirectory(): Promise<void> {
    const directory = await hostBridge.pickDirectory();
    if (!directory) {
      return;
    }

    await refreshWorkspace(directory, null);
  }

  async function reloadSelectedDocument(
    sourcePath: string | null = selectedSourcePath,
  ): Promise<void> {
    if (!sourcePath) {
      return;
    }

    try {
      const document = await hostBridge.loadSource(sourcePath);
      if (mountedRef.current) {
        setLoadedDocument(document);
      }
    } catch (error) {
      if (mountedRef.current) {
        setDocumentError(
          error instanceof Error ? error.message : "重新加载文件失败。",
        );
      }
    }
  }

  async function handleSaveSettings(nextValue: AppSettings): Promise<void> {
    const persisted = await hostBridge.saveSettings(nextValue);
    setSettings(persisted);
    setSettingsTestResult("设置已保存。");
    if (workspaceRoot) {
      await refreshWorkspace(workspaceRoot, selectedSourcePath, true);
    }
    if (selectedSourcePath) {
      await reloadSelectedDocument();
    }
    setSettingsOpen(false);
  }

  async function handleThemePreferenceChange(
    uiThemePreference: AppSettings["uiThemePreference"],
  ): Promise<void> {
    const optimistic = { ...settings, uiThemePreference };
    setSettings(optimistic);
    try {
      const persisted = await hostBridge.saveSettings(optimistic);
      setSettings(persisted);
    } catch (error) {
      setSettings((current) => ({ ...current, uiThemePreference: settings.uiThemePreference }));
      setSettingsTestResult(
        error instanceof Error ? error.message : "主题设置保存失败。",
      );
    }
  }

  async function handleTestConnection(grpcAddress: string): Promise<void> {
    setSettingsTesting(true);
    try {
      const result = await hostBridge.testGrpcConnection(grpcAddress);
      setSettingsTestResult(result.message);
    } finally {
      setSettingsTesting(false);
    }
  }

  async function handleRunSelected(force: boolean): Promise<void> {
    if (!selectedEntry || !workspaceRoot) {
      return;
    }

    setIsRunningSelected(true);
    setDocumentError(null);
    updateEntryOverride(selectedEntry.sourcePath, { status: "running" });
    const sourcePath = selectedEntry.sourcePath;
    let pollId: number | null = null;

    try {
      const runPromise = hostBridge.runDenoise(sourcePath, { force });
      await reloadSelectedDocument(sourcePath);
      pollId = window.setInterval(() => {
        if (selectedSourcePathRef.current === sourcePath) {
          void reloadSelectedDocument(sourcePath);
        }
      }, DENOISE_RESULT_POLL_INTERVAL_MS);

      await runPromise;
      clearEntryOverride(selectedEntry.sourcePath);
      await refreshWorkspace(workspaceRoot, selectedEntry.sourcePath, true);
      await reloadSelectedDocument(sourcePath);
    } catch (error) {
      updateEntryOverride(selectedEntry.sourcePath, {
        status: "error",
        message: error instanceof Error ? error.message : "降噪失败。",
      });
      setDocumentError(
        error instanceof Error ? error.message : "降噪失败。",
      );
    } finally {
      if (pollId !== null) {
        window.clearInterval(pollId);
      }
      setIsRunningSelected(false);
    }
  }

  async function handleRunDirectory(
    directory: SourceDirectory,
    force: boolean,
  ): Promise<void> {
    if (!workspaceTree || !workspaceRoot) {
      return;
    }

    const targetDirectory =
      findDirectoryByRelativePath(workspaceTree, directory.relativePath) ?? directory;
    const entries = flattenEntries(targetDirectory).filter(
      (entry) => entry.denoiseEligibility.supported,
    );
    if (entries.length === 0) {
      setBatchState({
        isRunning: false,
        label: directory.name,
        total: 0,
        completed: 0,
        skipped: 0,
        failures: [],
        currentSourcePath: null,
      });
      return;
    }

    setBatchState({
      isRunning: true,
      label: directory.name,
      total: entries.length,
      completed: 0,
      skipped: 0,
      failures: [],
      currentSourcePath: null,
    });

    let completed = 0;
    let skipped = 0;
    const failures: Array<{ sourcePath: string; message: string }> = [];

    for (const entry of entries) {
      updateEntryOverride(entry.sourcePath, { status: "running" });
      setBatchState((current) =>
        current
          ? {
              ...current,
              currentSourcePath: entry.sourcePath,
            }
          : current,
      );

      try {
        const result = await hostBridge.runDenoise(entry.sourcePath, { force });
        if (result.skipped) {
          skipped += 1;
        } else {
          completed += 1;
        }
        clearEntryOverride(entry.sourcePath);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "批处理失败。";
        failures.push({
          sourcePath: entry.sourcePath,
          message,
        });
        updateEntryOverride(entry.sourcePath, {
          status: "error",
          message,
        });
      }

      setBatchState((current) =>
        current
          ? {
              ...current,
              completed,
              skipped,
              failures: [...failures],
            }
          : current,
      );
    }

    setBatchState((current) =>
      current
        ? {
            ...current,
            isRunning: false,
            currentSourcePath: null,
            completed,
            skipped,
            failures,
          }
        : current,
    );

    await refreshWorkspace(workspaceRoot, selectedSourcePath, true);
    if (selectedSourcePath) {
      await reloadSelectedDocument();
    }
  }

  function updateEntryOverride(sourcePath: string, override: EntryOverride): void {
    setEntryOverrides((current) => {
      const next = new Map(current);
      next.set(sourcePath, override);
      return next;
    });
  }

  function clearEntryOverride(sourcePath: string): void {
    setEntryOverrides((current) => {
      const next = new Map(current);
      next.delete(sourcePath);
      return next;
    });
  }

  async function handleCopyFileName(): Promise<void> {
    if (!selectedEntry) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedEntry.stem);
      setCopyFeedback("已复制");
      window.setTimeout(() => {
        if (mountedRef.current) {
          setCopyFeedback(null);
        }
      }, 1400);
    } catch {
      setCopyFeedback("复制失败");
    }
  }

  function handleSeek(nextTime: number): void {
    playbackSnapshotRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
    syncAudioElements(sourceAudioRef.current, resultAudioRef.current, nextTime);
  }

  async function togglePlayback(target: "source" | "result"): Promise<void> {
    const targetAudio = target === "source" ? sourceAudioRef.current : resultAudioRef.current;
    const otherAudio = target === "source" ? resultAudioRef.current : sourceAudioRef.current;
    if (!targetAudio) {
      return;
    }

    const resumeTime = playbackSnapshotRef.current.currentTime;
    otherAudio?.pause();
    targetAudio.currentTime = resumeTime;
    setActivePlayback(target);
    await targetAudio.play();
    setIsPlaying(true);
  }

  async function toggleCurrentPlayback(): Promise<void> {
    if (playbackMode === "source" && activePlayback !== "source" && sourceTrack) {
      await togglePlayback("source");
      return;
    }

    if (playbackMode === "result" && activePlayback !== "result" && resultTrack) {
      await togglePlayback("result");
      return;
    }

    const activeAudio =
      activePlayback === "source" ? sourceAudioRef.current : resultAudioRef.current;
    if (activeAudio) {
      if (isPlaying) {
        handleSeek(activeAudio.currentTime);
        pausePlayback(sourceAudioRef, resultAudioRef, setIsPlaying);
        return;
      }

      await togglePlayback(activePlayback);
      return;
    }

    if (sourceTrack) {
      setActivePlayback("source");
      await togglePlayback("source");
      return;
    }

    if (resultTrack) {
      setActivePlayback("result");
      await togglePlayback("result");
    }
  }

  async function selectPlaybackTarget(
    target: "source" | "result",
  ): Promise<void> {
    const hasTrack = target === "source" ? Boolean(sourceTrack) : Boolean(resultTrack);
    if (!hasTrack) {
      return;
    }

    if (isPlaying) {
      await togglePlayback(target);
      if (playbackMode !== "ab") {
        setPlaybackMode(target);
      }
      return;
    }

    setActivePlayback(target);
    if (playbackMode !== "ab") {
      setPlaybackMode(target);
    }
  }

  async function handlePlaybackModeChange(nextMode: PlaybackMode): Promise<void> {
    if (nextMode === "ab") {
      setPlaybackMode("ab");
      return;
    }

    setPlaybackMode(nextMode);
    await selectPlaybackTarget(nextMode);
  }

  async function handlePrimaryAction(): Promise<void> {
    if (!selectedEntry) {
      return;
    }

    if (selectedEntry.resultPath) {
      await hostBridge.openPath(selectedEntry.resultPath);
      return;
    }

    await handleRunSelected(false);
  }

  function handleAudioProgress(target: "source" | "result"): void {
    const audio = target === "source" ? sourceAudioRef.current : resultAudioRef.current;
    if (!audio || activePlayback !== target) {
      return;
    }

    setCurrentTime(audio.currentTime);
    const durationSec =
      sourceTrack?.document.durationSec ??
      resultTrack?.document.durationSec ??
      selectedEntry?.audioMeta.durationSec;
    if (durationSec) {
      setViewport((current) =>
        followViewportWithPlayhead(current, audio.currentTime, durationSec),
      );
    }
  }

  const worktreeEmpty = !workspaceTree && !workspaceRoot;

  return (
    <div
      className="app-root"
      data-theme-mode={resolvedThemeMode}
      style={themeStyle}
    >
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <p className="eyebrow">离线降噪</p>
              <h1>Vishuddhi</h1>
            </div>
            <div className="sidebar-header-actions">
              <ThemeSwitch
                compact
                value={settings.uiThemePreference}
                onChange={(nextValue) => void handleThemePreferenceChange(nextValue)}
              />
              <button className="ghost-button" onClick={() => setSettingsOpen(true)}>
                设置
              </button>
            </div>
          </div>

          <div className="path-card">
            <span className="label">工作区</span>
            <div className="path-row">
              <code>{workspaceRoot ?? "尚未选择目录"}</code>
              <button className="action-button compact-button" onClick={handlePickDirectory}>
                选择目录
              </button>
            </div>
          </div>

          <div className="filter-panel">
            <div className="filter-header">
              <div className="filter-header-copy">
                <span className="label">文件</span>
                <span className="filter-count">{statusCounts.all} 个文件</span>
              </div>
            </div>
            <label className="search-field">
              <span>搜索</span>
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索文件名或路径"
              />
            </label>

            <div className="filter-chip-row">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={`filter-chip ${entryFilter === option ? "filter-chip-active" : ""}`}
                  onClick={() => setEntryFilter(option)}
                >
                  {option === "all" ? "全部" : formatRuntimeStatus(option as RuntimeEntryStatus)} {statusCounts[option]}
                </button>
              ))}
            </div>

            {workspaceTree ? (
              <details className="batch-strategy">
                <summary>批处理策略</summary>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={forceBatch}
                    onChange={(event) => setForceBatch(event.target.checked)}
                  />
                  <span>批量时覆盖已存在结果</span>
                </label>
                <button
                  className="action-button secondary"
                  onClick={() => void handleRunDirectory(workspaceTree, forceBatch)}
                  disabled={Boolean(batchState?.isRunning)}
                >
                  整库批量运行
                </button>
              </details>
            ) : null}
          </div>

          <div className="tree-panel">
            {isWorkspaceLoading ? (
              <div className="empty-sidebar">正在扫描目录…</div>
            ) : workspaceError ? (
              <div className="empty-sidebar">{workspaceError}</div>
            ) : filteredTree ? (
              <div className="directory-tree">
                {filteredTree.entries.map((entry) => (
                  <FileRow
                    key={entry.sourcePath}
                    entry={entry}
                    isActive={entry.sourcePath === selectedSourcePath}
                    status={resolveEntryStatus(entry, entryOverrides.get(entry.sourcePath))}
                    onSelect={() => setSelectedSourcePath(entry.sourcePath)}
                  />
                ))}
                {filteredTree.directories.map((directory) => (
                  <DirectoryNode
                    key={directory.absolutePath}
                    directory={directory}
                    expandedDirectories={expandedDirectories}
                    entryOverrides={entryOverrides}
                    selectedSourcePath={selectedSourcePath}
                    onSelectEntry={setSelectedSourcePath}
                    onToggleDirectory={(relativePath) =>
                      setExpandedDirectories((current) => {
                        const next = new Set(current);
                        if (next.has(relativePath)) {
                          next.delete(relativePath);
                        } else {
                          next.add(relativePath);
                        }
                        return next;
                      })
                    }
                    onRunDirectory={(targetDirectory) =>
                      void handleRunDirectory(targetDirectory, forceBatch)
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="empty-sidebar">
                {worktreeEmpty ? "先选择一个目录开始。" : "当前筛选结果为空。"}
              </div>
            )}
          </div>

          {batchState ? (
            <div className="batch-card">
              <div className="filter-header">
                <span className="label">批处理</span>
                <span className={`status-chip ${batchState.isRunning ? "active" : ""}`}>
                  {batchState.isRunning ? "运行中" : "已结束"}
                </span>
              </div>
              <strong>{batchState.label}</strong>
              <p>
                完成 {batchState.completed}/{batchState.total}，跳过 {batchState.skipped}
              </p>
              <p className="batch-current">
                {batchState.currentSourcePath ?? "等待下一次批量任务"}
              </p>
              {batchState.failures.length > 0 ? (
                <div className="batch-errors">
                  {batchState.failures.slice(0, 3).map((failure) => (
                    <div key={failure.sourcePath}>
                      <strong>{failure.sourcePath}</strong>
                      <span>{failure.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>

        <main className="workspace">
          {selectedEntry ? (
            <>
              <header className="workspace-topbar">
                <div className="workspace-heading">
                  <div className="workspace-title-row">
                    <span className="current-marker">当前选中</span>
                    <h2 title={selectedEntry.stem}>{friendlyStem}</h2>
                    <button
                      className="ghost-button compact-button"
                      title={selectedEntry.stem}
                      onClick={() => void handleCopyFileName()}
                    >
                      {copyFeedback ?? "复制"}
                    </button>
                    <span className={`status-chip status-${selectedStatus}`}>
                      {selectedStatus ? formatRuntimeStatus(selectedStatus) : ""}
                    </span>
                    <span className="spectrogram-badge">{formatKindLabel(selectedEntry.kind)}</span>
                  </div>
                  <div className="workspace-summary-strip">
                    <span>{formatKindLabel(selectedEntry.kind)}</span>
                    <span>{formatSampleRate(selectedEntry.audioMeta.sampleRate)}</span>
                    <span>{formatDuration(selectedEntry.audioMeta.durationSec)}</span>
                    <span>{getResultAvailabilityLabel(selectedEntry)}</span>
                    <span title={selectedEntry.sourcePath}>{getEntrySourceLabel(selectedEntry)}</span>
                  </div>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="action-button action-button-attention"
                    onClick={() => void handlePrimaryAction()}
                    disabled={getPrimaryActionDisabled(selectedEntry, isRunningSelected, Boolean(batchState?.isRunning))}
                  >
                    {getPrimaryActionLabel(selectedEntry)}
                  </button>
                  {selectedEntry.denoiseEligibility.supported ? (
                    <button
                      className="ghost-button"
                      onClick={() => void handleRunSelected(true)}
                      disabled={isRunningSelected || Boolean(batchState?.isRunning)}
                    >
                      重新运行
                    </button>
                  ) : null}
                  <div className="toolbar-menu">
                    <button
                      className="ghost-button floating-toggle"
                      onClick={() => setIsFileMenuOpen((current) => !current)}
                    >
                      更多
                    </button>
                    {isFileMenuOpen ? (
                      <div className="floating-menu">
                        <button
                          className="ghost-button"
                          onClick={() => {
                            setIsFileMenuOpen(false);
                            void hostBridge.revealPath(selectedEntry.sourcePath);
                          }}
                        >
                          在文件夹中显示
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            setIsFileMenuOpen(false);
                            setSettingsOpen(true);
                          }}
                        >
                          设置
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </header>

              {documentError ? <div className="error-banner">{documentError}</div> : null}
              {!selectedEntry.denoiseEligibility.supported && selectedEntry.denoiseEligibility.reason ? (
                <div className="info-banner">{selectedEntry.denoiseEligibility.reason}</div>
              ) : null}

              <OverviewTimeline
                durationSec={sourceTrack?.document.durationSec ?? selectedEntry.audioMeta.durationSec}
                currentTime={currentTime}
                viewport={viewport}
                onSeek={handleSeek}
                onViewportChange={setViewport}
              />

              <div className="spectrogram-stack">
                <SpectrogramPane
                  title="原始"
                  subtitle="原始"
                  document={sourceTrack?.document ?? null}
                  isActive={activePlayback === "source"}
                  allowFullRender={activePlayback === "source"}
                  viewport={viewport}
                  currentTime={currentTime}
                  themeMode={resolvedThemeMode}
                  workerClient={workerClient}
                  onActivate={() => {
                    void selectPlaybackTarget("source");
                  }}
                  onSeek={handleSeek}
                  onViewportChange={setViewport}
                  emptyState={{
                    title: "等待原始音频",
                    detail: "选择文件后会在这里渲染语谱图。",
                  }}
                />
                <SpectrogramPane
                  title="降噪后"
                  subtitle="降噪后"
                  document={resultTrack?.document ?? null}
                  isActive={activePlayback === "result"}
                  allowFullRender={activePlayback === "result"}
                  viewport={viewport}
                  currentTime={currentTime}
                  themeMode={resolvedThemeMode}
                  workerClient={workerClient}
                  onActivate={() => {
                    void selectPlaybackTarget("result");
                  }}
                  onSeek={handleSeek}
                  onViewportChange={setViewport}
                  emptyState={{
                    title: "结果还不存在",
                    detail: "运行单文件降噪后，这里会自动载入结果谱图用于对比。",
                    actionLabel: selectedEntry.denoiseEligibility.supported ? "立即降噪" : undefined,
                    onAction: selectedEntry.denoiseEligibility.supported
                      ? () => void handleRunSelected(false)
                      : undefined,
                  }}
                />
              </div>

              <footer className="transport-bar">
                <div className="transport-controls">
                  <button className="action-button" onClick={() => void toggleCurrentPlayback()}>
                    {isPlaying ? "暂停" : "播放"}
                  </button>
                  <div className="segmented-control">
                    {([
                      ["source", "原始"],
                      ["result", "结果"],
                      ["ab", "A-B 对比"],
                    ] as const).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={`ghost-button ${playbackMode === mode ? "mode-switch-active" : ""}`}
                        onClick={() => void handlePlaybackModeChange(mode)}
                        disabled={mode !== "source" && !resultTrack}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <TransportTimeline
                  durationSec={sourceTrack?.document.durationSec ?? selectedEntry.audioMeta.durationSec}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                />
                <div className="transport-readout">
                  <div className="transport-meta">
                    <span>
                      播放源：{playbackMode === "ab" ? `A-B 对比（当前${activePlayback === "source" ? "原始" : "结果"}）` : playbackMode === "source" ? "原始" : "结果"}
                    </span>
                    <div className="transport-actions">
                      <button
                        className="ghost-button"
                        onClick={() =>
                          setViewport(
                            createInitialViewport(
                              sourceTrack?.document.durationSec ??
                                selectedEntry.audioMeta.durationSec,
                            ),
                          )
                        }
                      >
                        适配视图
                      </button>
                      <div className="toolbar-menu">
                        <button
                          className="ghost-button floating-toggle"
                          onClick={() => setIsHelpOpen((current) => !current)}
                        >
                          快捷键
                        </button>
                        {isHelpOpen ? (
                          <div className="floating-menu help-popover">
                            <span>空格：播放 / 暂停</span>
                            <span>{settings.sourceHotkey.toUpperCase()}：切到原始</span>
                            <span>{settings.resultHotkey.toUpperCase()}：切到结果</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="transport-timing">
                    <strong>{formatDuration(currentTime)}</strong>
                    <span>/ {formatDuration(sourceTrack?.document.durationSec ?? selectedEntry.audioMeta.durationSec)}</span>
                  </div>
                </div>
              </footer>
            </>
          ) : (
            <div className="workspace-empty">
              <div>
                <p className="eyebrow">工作区</p>
                <h2>选择一个音频目录开始</h2>
                <p>左侧会显示按目录分组的文件列表。选中任意音频后，就可以直接试听、对比和运行离线降噪。</p>
              </div>
              <button className="action-button action-button-attention" onClick={handlePickDirectory}>
                打开目录
              </button>
            </div>
          )}
        </main>
      </div>

      <SettingsDialog
        isOpen={settingsOpen}
        value={settings}
        isTesting={settingsTesting}
        testResult={settingsTestResult}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        onTestConnection={handleTestConnection}
        onRestoreDefaults={() => {
          setSettingsTestResult("已恢复默认值，点击保存后生效。");
          return DEFAULT_SETTINGS;
        }}
      />

      <audio
        ref={sourceAudioRef}
        src={sourceTrack?.blobUrl}
        onTimeUpdate={() => handleAudioProgress("source")}
        onEnded={() => setIsPlaying(false)}
      />
      <audio
        ref={resultAudioRef}
        src={resultTrack?.blobUrl}
        onTimeUpdate={() => handleAudioProgress("result")}
        onEnded={() => setIsPlaying(false)}
      />
    </div>
  );
}

interface OverviewTimelineProps {
  durationSec: number;
  currentTime: number;
  viewport: TimeRange;
  onSeek(nextTimeSec: number): void;
  onViewportChange(nextRange: TimeRange): void;
}

function OverviewTimeline({
  durationSec,
  currentTime,
  viewport,
  onSeek,
  onViewportChange,
}: OverviewTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    originStartSec: number;
    spanSec: number;
  } | null>(null);
  const safeDuration = Math.max(durationSec, MIN_TIME_WINDOW_SEC);
  const spanSec = getViewportSpan(viewport);
  const startPercent = (viewport.startSec / safeDuration) * 100;
  const widthPercent = Math.max((spanSec / safeDuration) * 100, 1.5);
  const playheadPercent = (clamp(currentTime, 0, safeDuration) / safeDuration) * 100;

  useEffect(() => {
    function handleWindowPointerMove(event: PointerEvent): void {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !track) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const deltaSec =
        ((event.clientX - drag.startX) / Math.max(rect.width, 1)) * safeDuration;
      onViewportChange(
        clampViewportToDuration(
          safeDuration,
          drag.originStartSec + deltaSec,
          drag.spanSec,
        ),
      );
    }

    function handleWindowPointerEnd(event: PointerEvent): void {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      dragRef.current = null;
    }

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerEnd);
    window.addEventListener("pointercancel", handleWindowPointerEnd);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerEnd);
    };
  }, [onViewportChange, safeDuration]);

  function seekFromClientX(clientX: number): void {
    if (!trackRef.current) {
      return;
    }

    const rect = trackRef.current.getBoundingClientRect();
    const alpha = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    const targetTimeSec = alpha * safeDuration;
    onSeek(targetTimeSec);
    onViewportChange(
      clampViewportToDuration(safeDuration, targetTimeSec - spanSec / 2, spanSec),
    );
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".overview-window")
    ) {
      return;
    }

    seekFromClientX(event.clientX);
  }

  function handleWindowPointerDown(
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (!trackRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      originStartSec: viewport.startSec,
      spanSec,
    };
  }

  return (
    <section className="overview-card">
      <div className="overview-header">
        <span className="label">可视区间</span>
        <span className="overview-readout">
          当前视窗 {formatDuration(viewport.startSec)} - {formatDuration(viewport.endSec)}
          <span> / 总长 {formatDuration(safeDuration)}</span>
        </span>
      </div>
      <div
        ref={trackRef}
        className="overview-track"
        onPointerDown={handlePointerDown}
      >
        <div className="overview-track-fill" />
        <div
          className="overview-window"
          onPointerDown={handleWindowPointerDown}
          style={{
            left: `${startPercent}%`,
            width: `${Math.min(widthPercent, 100 - startPercent)}%`,
          }}
        />
        <div
          className="overview-playhead"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>
    </section>
  );
}

interface TransportTimelineProps {
  durationSec: number;
  currentTime: number;
  onSeek(nextTimeSec: number): void;
}

function TransportTimeline({
  durationSec,
  currentTime,
  onSeek,
}: TransportTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const safeDuration = Math.max(durationSec, MIN_TIME_WINDOW_SEC);
  const progressPercent = (clamp(currentTime, 0, safeDuration) / safeDuration) * 100;

  useEffect(() => {
    function handlePointerMove(event: PointerEvent): void {
      if (dragRef.current !== event.pointerId || !trackRef.current) {
        return;
      }

      const rect = trackRef.current.getBoundingClientRect();
      const alpha = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      onSeek(alpha * safeDuration);
    }

    function handlePointerEnd(event: PointerEvent): void {
      if (dragRef.current === event.pointerId) {
        dragRef.current = null;
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [onSeek, safeDuration]);

  function seek(clientX: number): void {
    if (!trackRef.current) {
      return;
    }

    const rect = trackRef.current.getBoundingClientRect();
    const alpha = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    onSeek(alpha * safeDuration);
  }

  return (
    <div
      ref={trackRef}
      className="transport-timeline"
      onPointerDown={(event) => {
        dragRef.current = event.pointerId;
        seek(event.clientX);
      }}
    >
      <div className="transport-timeline-fill" style={{ width: `${progressPercent}%` }} />
      <div className="transport-timeline-playhead" style={{ left: `${progressPercent}%` }} />
    </div>
  );
}

function pausePlayback(
  sourceAudioRef: RefObject<HTMLAudioElement | null>,
  resultAudioRef: RefObject<HTMLAudioElement | null>,
  setIsPlaying: (value: boolean) => void,
): void {
  sourceAudioRef.current?.pause();
  resultAudioRef.current?.pause();
  setIsPlaying(false);
}

function syncAudioElements(
  sourceAudio: HTMLAudioElement | null,
  resultAudio: HTMLAudioElement | null,
  currentTime: number,
): void {
  for (const audio of [sourceAudio, resultAudio]) {
    if (!audio) {
      continue;
    }

    if (Math.abs(audio.currentTime - currentTime) > 0.08) {
      audio.currentTime = currentTime;
    }
  }
}

async function hydrateTrack(
  workerClient: SpectrogramWorkerClient,
  audioUrl: string,
  documentId: string,
  sampleRate: number,
  signal: AbortSignal,
): Promise<HydratedTrack> {
  const hydrated = await hydrateAudio(audioUrl, sampleRate, signal);
  workerClient.loadDocument(
    documentId,
    hydrated.waveform.workerChannelData,
    hydrated.waveform.sampleRate,
  );
  return {
    document: {
      documentId,
      sampleRate: hydrated.waveform.sampleRate,
      durationSec: hydrated.waveform.durationSec,
    },
    blobUrl: hydrated.blobUrl,
    workerChannelData: hydrated.waveform.workerChannelData,
  };
}

function disposeTrack(
  workerClient: SpectrogramWorkerClient,
  track: HydratedTrack | null,
): void {
  if (!track) {
    return;
  }

  workerClient.unloadDocument(track.document.documentId);
  URL.revokeObjectURL(track.blobUrl);
}

interface DirectoryNodeProps {
  directory: SourceDirectory;
  expandedDirectories: Set<string>;
  entryOverrides: Map<string, EntryOverride>;
  selectedSourcePath: string | null;
  onSelectEntry(sourcePath: string): void;
  onToggleDirectory(relativePath: string): void;
  onRunDirectory(directory: SourceDirectory): void;
}

function DirectoryNode({
  directory,
  expandedDirectories,
  entryOverrides,
  selectedSourcePath,
  onSelectEntry,
  onToggleDirectory,
  onRunDirectory,
}: DirectoryNodeProps) {
  const isExpanded =
    directory.relativePath === "" || expandedDirectories.has(directory.relativePath);

  return (
    <div className="directory-node">
      <div className="directory-row">
        <button
          className="directory-button"
          onClick={() => onToggleDirectory(directory.relativePath)}
        >
          <span className={`directory-caret ${isExpanded ? "expanded" : ""}`}>▸</span>
          <span className="directory-name">{directory.name}</span>
        </button>
        <div className="directory-meta">
          <span>{getDirectoryEntryCount(directory)} 个文件</span>
          <button
            className="ghost-button compact-button"
            onClick={() => onRunDirectory(directory)}
          >
            批量运行
          </button>
        </div>
      </div>

      {isExpanded ? (
        <div className="directory-children">
          {directory.entries.map((entry) => (
            <FileRow
              key={entry.sourcePath}
              entry={entry}
              isActive={entry.sourcePath === selectedSourcePath}
              status={resolveEntryStatus(entry, entryOverrides.get(entry.sourcePath))}
              onSelect={() => onSelectEntry(entry.sourcePath)}
            />
          ))}
          {directory.directories.map((child) => (
            <DirectoryNode
              key={child.absolutePath}
              directory={child}
              expandedDirectories={expandedDirectories}
              entryOverrides={entryOverrides}
              selectedSourcePath={selectedSourcePath}
              onSelectEntry={onSelectEntry}
              onToggleDirectory={onToggleDirectory}
              onRunDirectory={onRunDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface FileRowProps {
  entry: SourceEntry;
  status: RuntimeEntryStatus;
  isActive: boolean;
  onSelect(): void;
}

function FileRow({ entry, status, isActive, onSelect }: FileRowProps) {
  return (
    <button className={`tree-entry ${isActive ? "active" : ""}`} onClick={onSelect}>
      <div className="tree-entry-main">
        <div className="file-row-title">
          <strong title={entry.stem}>{formatFriendlyStem(entry.stem, 28)}</strong>
          <span className={`badge ${status}`}>{formatRuntimeStatus(status)}</span>
        </div>
        <span>{buildSummaryLine(entry)}</span>
      </div>
      <div className="entry-meta">
        <span>{formatDuration(entry.audioMeta.durationSec)}</span>
      </div>
    </button>
  );
}
