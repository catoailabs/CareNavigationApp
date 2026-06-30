import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { concurrently } from 'concurrently'
import {
  allProjectPorts,
  killExistingProjectProcesses,
  killProcessesOnPorts,
  portsInUse,
  runProjectCheck,
} from './dev-utils.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 1) Check the project ports and kill anything left running on them.
//    Project ports: 5173 (frontend UI / Vite), 8000 (backend agent / uvicorn),
//    9222 (virtual desktop browser / Chromium CDP).
// ---------------------------------------------------------------------------
runProjectCheck()
const ports = allProjectPorts()
const killedByPort = killProcessesOnPorts(ports)
const killedByPattern = killExistingProjectProcesses(process.pid)

if (killedByPort || killedByPattern) {
  const deadline = Date.now() + 10000
  let blocked = portsInUse(ports)
  while (blocked.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    blocked = portsInUse(ports)
  }
  if (blocked.length > 0) {
    console.error(`[dev] unable to free project ports: ${blocked.join(', ')}`)
    process.exit(1)
  }
  console.log('[dev] project ports freed')
} else {
  console.log('[dev] project ports are clear')
}

// ---------------------------------------------------------------------------
// 2) Launch the stack with concurrently in the correct startup order:
//    virtual desktop (slowest, detached docker) -> backend agent -> frontend UI.
//    The frontend's Vite proxy targets the agent (8000) and desktop CDP (9222),
//    so those are listed first; Vite's proxy connects lazily once they are up.
// ---------------------------------------------------------------------------
const autostartDesktop = process.env.PROVIDER_BROWSER_AUTOSTART !== '0'

const commands = []
if (autostartDesktop) {
  commands.push({ command: 'npm run dev:browser', name: 'desktop', prefixColor: 'blue' })
} else {
  console.log('[dev] PROVIDER_BROWSER_AUTOSTART=0 — skipping virtual desktop')
}
commands.push({ command: 'npm run dev:agent', name: 'agent', prefixColor: 'magenta' })
commands.push({ command: 'npm run dev:app', name: 'app', prefixColor: 'cyan' })

const { result } = concurrently(commands, {
  cwd: root,
  prefix: 'name',
  // Tear the whole stack down if the agent or frontend crashes. The virtual
  // desktop command exits 0 immediately (docker compose up -d is detached),
  // so 'success' is intentionally excluded to keep the stack running.
  killOthersOn: ['failure'],
  restartTries: 0,
})

result.then(
  () => process.exit(0),
  () => process.exit(1),
)
