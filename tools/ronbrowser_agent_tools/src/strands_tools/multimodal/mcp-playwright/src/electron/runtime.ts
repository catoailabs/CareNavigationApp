import { createRequire } from 'node:module';

export function isElectronMainProcess(): boolean {
  const proc = process as NodeJS.Process & { type?: string };
  return Boolean(process.versions?.electron) && proc.type === 'browser';
}

export function isElectronRenderer(): boolean {
  const proc = process as NodeJS.Process & { type?: string };
  return Boolean(process.versions?.electron) && proc.type === 'renderer';
}

export function getElectronModule(): any | null {
  try {
    const require = createRequire(import.meta.url);
    return require('electron');
  } catch (error) {
    return null;
  }
}
