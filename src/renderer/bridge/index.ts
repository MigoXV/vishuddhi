import type { HostBridge } from "@shared/contracts";

import { browserHostBridge } from "./browser";

export function getHostBridge(): HostBridge {
  return window.vishuddhiHost ?? browserHostBridge;
}
