import { useEffect, useState } from "react";

import type { AppSettings } from "@shared/contracts";

import { ThemeSwitch } from "./ThemeSwitch";

function normalizeHotkeyInput(value: string): string {
  const nextValue = value.trim().toLowerCase();
  const match = nextValue.match(/[a-z0-9]/);
  return match ? match[0] : "";
}

interface SettingsDialogProps {
  isOpen: boolean;
  value: AppSettings;
  isTesting: boolean;
  testResult: string | null;
  onClose(): void;
  onSave(nextValue: AppSettings): Promise<void> | void;
  onTestConnection(grpcAddress: string): Promise<void> | void;
  onRestoreDefaults(): AppSettings;
}

export function SettingsDialog({
  isOpen,
  value,
  isTesting,
  testResult,
  onClose,
  onSave,
  onTestConnection,
  onRestoreDefaults,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState<AppSettings>(value);

  useEffect(() => {
    if (isOpen) {
      setDraft(value);
    }
  }, [isOpen, value]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <p className="eyebrow">Connection</p>
            <h2 id="settings-title">工作台设置</h2>
          </div>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <label className="settings-field">
          <span>gRPC 地址</span>
          <input
            aria-label="gRPC 地址"
            value={draft.grpcAddress}
            onChange={(event) =>
              setDraft((current) => ({ ...current, grpcAddress: event.target.value }))
            }
            placeholder="localhost:7860"
          />
        </label>

        <div className="settings-field">
          <span>主题</span>
          <ThemeSwitch
            value={draft.uiThemePreference}
            onChange={(uiThemePreference) =>
              setDraft((current) => ({ ...current, uiThemePreference }))
            }
          />
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>PCM 采样率</span>
            <input
              aria-label="PCM 采样率"
              type="number"
              min={1000}
              step={100}
              value={draft.pcmSampleRate}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  pcmSampleRate: Number(event.target.value) || current.pcmSampleRate,
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>DAT 采样率</span>
            <input
              aria-label="DAT 采样率"
              type="number"
              min={1000}
              step={100}
              value={draft.datSampleRate}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  datSampleRate: Number(event.target.value) || current.datSampleRate,
                }))
              }
            />
          </label>
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>原始语音热键</span>
            <input
              aria-label="原始语音热键"
              maxLength={1}
              value={draft.sourceHotkey}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sourceHotkey:
                    normalizeHotkeyInput(event.target.value) || current.sourceHotkey,
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>结果语音热键</span>
            <input
              aria-label="结果语音热键"
              maxLength={1}
              value={draft.resultHotkey}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  resultHotkey:
                    normalizeHotkeyInput(event.target.value) || current.resultHotkey,
                }))
              }
            />
          </label>
        </div>

        <div className="settings-status">
          <span>{testResult ?? "保存后会立刻刷新当前工作区元数据。"}</span>
        </div>

        <footer className="settings-actions">
          <button
            className="ghost-button"
            onClick={() => setDraft(onRestoreDefaults())}
          >
            恢复默认值
          </button>
          <div className="settings-actions-right">
            <button
              className="ghost-button"
              onClick={() => onTestConnection(draft.grpcAddress)}
              disabled={isTesting}
            >
              {isTesting ? "测试中…" : "测试连接"}
            </button>
            <button className="action-button action-button-attention" onClick={() => onSave(draft)}>
              保存设置
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
