import { startHttpServer } from '../http-server.js';
import { loadElectronConfig, setElectronConfig, type EmbedType, type AutomationMode, type HeadlessTarget } from './config.js';
import { getCdpUrlFromApp, getFocusedTargetInfo, getTargetInfoForWebContents } from './targets.js';
import { getElectronModule, isElectronMainProcess } from './runtime.js';
import { ensureHeadlessWebContents } from './headless.js';

export interface ElectronServerOptions {
  mcpPort?: number;
  cdpPort?: number;
  iframeSelector?: string;
  iframeType?: EmbedType;
  mode?: AutomationMode;
  headlessTarget?: HeadlessTarget;
}

export async function startElectronMcpServer(options: ElectronServerOptions = {}): Promise<void> {
  if (!isElectronMainProcess()) {
    throw new Error('startElectronMcpServer must be called from the Electron main process.');
  }

  const electron = getElectronModule();
  if (!electron) {
    throw new Error('Electron module is not available in this runtime.');
  }

  if (options.cdpPort && !electron.app.isReady()) {
    electron.app.commandLine.appendSwitch('remote-debugging-port', String(options.cdpPort));
  }

  await electron.app.whenReady();

  const targetInfo = options.mode === 'headless' && options.headlessTarget === 'electron'
    ? await getTargetInfoForWebContents(await ensureHeadlessWebContents())
    : await getFocusedTargetInfo();
  const cdpUrl = options.cdpPort ? `http://127.0.0.1:${options.cdpPort}` : getCdpUrlFromApp();

  setElectronConfig(loadElectronConfig({
    mode: options.mode ?? 'electron',
    cdpUrl,
    targetId: targetInfo?.targetId,
    iframeSelector: options.iframeSelector,
    iframeType: options.iframeType,
    headlessTarget: options.headlessTarget
  }));

  await startHttpServer(options.mcpPort ?? 8931);
}
