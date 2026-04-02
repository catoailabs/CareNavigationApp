import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const distEntry = resolve('dist/index.js');
const tscBin = process.platform === 'win32' ? 'node_modules/.bin/tsc.cmd' : 'node_modules/.bin/tsc';

let serverProcess;
let restartTimer;

function startServer() {
  if (!existsSync(distEntry)) {
    return;
  }
  if (serverProcess) {
    return;
  }
  serverProcess = spawn('node', [distEntry, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  serverProcess.on('exit', () => {
    serverProcess = undefined;
  });
}

function restartServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = undefined;
  }
  startServer();
}

const tscProcess = spawn(tscBin, ['--watch', '--preserveWatchOutput'], {
  stdio: 'inherit'
});

tscProcess.on('exit', (code) => {
  process.exit(code ?? 1);
});

startServer();

watch('dist', { recursive: true }, () => {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartServer();
  }, 200);
});

process.on('SIGINT', () => {
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (tscProcess) tscProcess.kill('SIGTERM');
  process.exit(0);
});

