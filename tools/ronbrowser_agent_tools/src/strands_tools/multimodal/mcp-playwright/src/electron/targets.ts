import { getElectronModule, isElectronMainProcess } from './runtime.js';

interface TargetInfoResult {
  targetInfo?: {
    targetId?: string;
  };
}

async function resolveTargetInfoForWebContents(webContents: any): Promise<{ targetId?: string; webContentsId?: number; windowId?: number } | undefined> {
  if (!webContents) return undefined;

  let targetId: string | undefined;
  let attached = false;

  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach();
      attached = true;
    }
    const result = await webContents.debugger.sendCommand('Target.getTargetInfo');
    targetId = (result as TargetInfoResult)?.targetInfo?.targetId;
  } catch (error) {
    targetId = undefined;
  } finally {
    try {
      if (attached && webContents.debugger.isAttached()) {
        webContents.debugger.detach();
      }
    } catch (error) {
      // Ignore detach failures.
    }
  }

  return {
    targetId,
    webContentsId: webContents.id,
    windowId: webContents.hostWebContents?.id ?? webContents.getOwnerBrowserWindow?.()?.id
  };
}

export async function getFocusedWebContents(): Promise<any | undefined> {
  if (!isElectronMainProcess()) return undefined;
  const electron = getElectronModule();
  if (!electron) return undefined;

  const focused = electron.webContents?.getFocusedWebContents?.();
  if (focused) return focused;

  const focusedWindow = electron.BrowserWindow?.getFocusedWindow?.();
  return focusedWindow?.webContents;
}

export async function getFocusedTargetInfo(): Promise<{ targetId?: string; webContentsId?: number; windowId?: number } | undefined> {
  const webContents = await getFocusedWebContents();
  return await resolveTargetInfoForWebContents(webContents);
}

export async function getTargetInfoForWebContents(webContents: any): Promise<{ targetId?: string; webContentsId?: number; windowId?: number } | undefined> {
  return await resolveTargetInfoForWebContents(webContents);
}

export function getCdpUrlFromApp(): string | undefined {
  if (!isElectronMainProcess()) return undefined;
  const electron = getElectronModule();
  if (!electron) return undefined;

  const port = electron.app?.commandLine?.getSwitchValue?.('remote-debugging-port');
  if (!port) return undefined;
  return `http://127.0.0.1:${port}`;
}
