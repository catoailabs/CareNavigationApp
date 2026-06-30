import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  killExistingProjectProcesses,
  portsInUse,
  projectPorts,
  runProjectCheck,
  waitForPort,
} from './dev-utils.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []
let shuttingDown = false

function colorFor(name) {
  switch (name) {
    case 'app':
      return '\x1b[36m'
    case 'browser':
      return '\x1b[34m'
    case 'runtime':
      return '\x1b[33m'
    case 'agent':
      return '\x1b[35m'
    default:
      return '\x1b[0m'
  }
}

function prefixOutput(name, stream, target) {
  const color = colorFor(name)
  const reset = '\x1b[0m'
  let buffered = ''

  stream.on('data', (chunk) => {
    buffered += chunk.toString()
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''

    for (const line of lines) {
      target.write(`${color}[${name}]${reset} ${line}\n`)
    }
  })

  stream.on('end', () => {
    if (buffered) {
      target.write(`${color}[${name}]${reset} ${buffered}\n`)
      buffered = ''
    }
  })
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  const isWindows = process.platform === 'win32'
  for (const child of children) {
    if (!child.killed && child.pid) {
      try {
        if (!isWindows) {
          process.kill(-child.pid, 'SIGTERM')
        } else {
          child.kill('SIGTERM')
        }
      } catch (e) {}
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.pid) {
        try {
          if (!isWindows) {
            process.kill(-child.pid, 'SIGKILL')
          } else {
            child.kill('SIGKILL')
          }
        } catch (e) {}
      }
    }
    process.exit(code)
  }, 750).unref()
}

function start(script, name) {
  const isWindows = process.platform === 'win32'
  const child = spawn(npmCmd, ['run', script], {
    cwd: root,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: !isWindows,
  })

  children.push(child)
  prefixOutput(name, child.stdout, process.stdout)
  prefixOutput(name, child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
    process.stderr.write(`[${name}] exited with ${detail}\n`)

    if (!shuttingDown) {
      shutdown(code ?? 1)
    }
  })
}

function startTransient(script, name) {
  const child = spawn(npmCmd, ['run', script], {
    cwd: root,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  prefixOutput(name, child.stdout, process.stdout)
  prefixOutput(name, child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    if ((code ?? 0) === 0) {
      return
    }

    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
    process.stderr.write(`[${name}] exited with ${detail}\n`)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const check = runProjectCheck()
const hadExisting = killExistingProjectProcesses(process.pid)
if (hadExisting) {
  const start = Date.now()
  const deadline = start + 10000
  let blocked = portsInUse(projectPorts())
  while (blocked.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    blocked = portsInUse(projectPorts())
  }
  if (blocked.length > 0) {
    console.error(`[dev] unable to free project ports: ${blocked.join(', ')}`)
    process.exit(1)
  }
  console.log('[dev] project ports freed')
} else if (check.project.length > 0) {
  console.error(`[dev] project ports already in use and no matching processes found: ${check.project.join(', ')}`)
  process.exit(1)
}

if (process.env.PROVIDER_BROWSER_AUTOSTART !== '0') {
  startTransient('dev:browser', 'browser')
}

start('dev:app', 'app')
start('dev:agent', 'agent')

;(async () => {
  const appPort = projectPorts()[0] ?? 5173
  const agentPort = projectPorts()[1] ?? 8000
  const appReady = await waitForPort(appPort, '127.0.0.1', 30000)
  if (!appReady) {
    console.error(`[dev] app did not become ready on port ${appPort}`)
    shutdown(1)
    return
  }
  const agentReady = await waitForPort(agentPort, '127.0.0.1', 30000)
  if (!agentReady) {
    console.error(`[dev] agent did not become ready on port ${agentPort}`)
    shutdown(1)
    return
  }
  console.log('[dev] app and agent are ready')
})()
