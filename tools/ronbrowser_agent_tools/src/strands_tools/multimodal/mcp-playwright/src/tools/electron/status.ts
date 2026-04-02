import { ToolHandler, ToolContext, ToolResponse, createErrorResponse, createSuccessResponse } from '../common/types.js';
import { getElectronConfig } from '../../electron/config.js';
import { getCdpUrlFromApp, getFocusedTargetInfo } from '../../electron/targets.js';
import { isElectronMainProcess } from '../../electron/runtime.js';

export class ElectronStatusTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const config = getElectronConfig();
      const focused = isElectronMainProcess() ? await getFocusedTargetInfo() : undefined;

      const status = {
        mode: config.mode,
        headlessTarget: config.headlessTarget,
        cdpUrl: config.cdpUrl ?? getCdpUrlFromApp(),
        targetId: config.targetId ?? focused?.targetId,
        bridgeUrl: config.bridgeUrl,
        iframeSelector: config.iframeSelector,
        iframeType: config.iframeType,
        allowDestructiveCdp: config.allowDestructiveCdp,
        runningInElectronMain: isElectronMainProcess(),
        focusedWebContentsId: focused?.webContentsId,
        focusedWindowId: focused?.windowId
      };

      return createSuccessResponse(JSON.stringify(status, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
