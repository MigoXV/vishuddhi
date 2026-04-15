// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppSettings } from "@shared/contracts";

import { SettingsDialog } from "./SettingsDialog";

const defaults: AppSettings = {
  grpcAddress: "localhost:7860",
  pcmSampleRate: 9600,
  datSampleRate: 9600,
  uiThemePreference: "system",
  sourceHotkey: "r",
  resultHotkey: "d",
};

describe("SettingsDialog", () => {
  it("restores defaults into the draft before saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SettingsDialog
        isOpen
        value={{
          grpcAddress: "10.0.0.1:9999",
          pcmSampleRate: 32000,
          datSampleRate: 44100,
          uiThemePreference: "dark",
          sourceHotkey: "q",
          resultHotkey: "w",
        }}
        isTesting={false}
        testResult={null}
        onClose={() => undefined}
        onSave={onSave}
        onTestConnection={() => undefined}
        onRestoreDefaults={() => defaults}
      />,
    );

    await user.click(screen.getByRole("button", { name: "恢复默认值" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(onSave).toHaveBeenCalledWith(defaults);
  });
});
