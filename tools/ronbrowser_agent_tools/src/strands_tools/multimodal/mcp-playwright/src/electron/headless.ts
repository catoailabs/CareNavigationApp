import { getElectronModule, isElectronMainProcess } from './runtime.js';

let headlessWindow: any | undefined;

export async function ensureHeadlessWebContents(): Promise<any> {
  if (!isElectronMainProcess()) {
    throw new Error('Headless Electron target requires the Electron main process.');
  }

  const electron = getElectronModule();
  if (!electron) {
    throw new Error('Electron module is not available in this runtime.');
  }

  await electron.app.whenReady();

  if (headlessWindow && !headlessWindow.isDestroyed()) {
    return headlessWindow.webContents;
  }

  headlessWindow = new electron.BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    focusable: false,
    skipTaskbar: true
  });

  headlessWindow.on('closed', () => {
    headlessWindow = undefined;
  });

  return headlessWindow.webContents;
}

