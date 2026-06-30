import { execFileSync } from 'node:child_process'
import process from 'node:process'

const PROJECT_PORTS = [5173, 8000]
const OPTIONAL_PORTS = [9222]

export function portsInUse(ports) {
  return ports.filter((port) => {
    try {
      const out = execFileSync('ss', ['-tlnH', `sport = :${port}`], { encoding: 'utf8', timeout: 2000 })
      return out.trim().length > 0
    } catch {
      try {
        const out = execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-P', '-n'], { encoding: 'utf8', timeout: 2000 })
        return out.trim().length > 0
      } catch {
        return false
      }
    }
  })
}

export function getProjectPids(ownPid) {
  const pids = new Set()
  const patterns = [
    'node.*vite',
    'node.*scripts/dev\\.mjs',
    'python.*-m uvicorn agent:app',
    'npm run dev:app',
    'npm run dev:agent',
  ]
  for (const pattern of patterns) {
    try {
      const output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 5000 })
      for (const line of output.trim().split(/\r?\n/)) {
        const pid = Number.parseInt(line.trim(), 10)
        if (pid > 0 && pid !== ownPid) {
          pids.add(pid)
        }
      }
    } catch {
      // pgrep exits 1 when no matches; that's fine.
    }
  }
  return [...pids]
}

export function pidsOnPort(port) {
  const pids = new Set()
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8', timeout: 3000 })
    for (const line of out.trim().split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid)
      }
    }
  } catch {
    // lsof missing or no listener; fall back to ss with process info.
    try {
      const out = execFileSync('ss', ['-tlnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 })
      const re = /pid=(\d+)/g
      let match
      while ((match = re.exec(out)) !== null) {
        const pid = Number.parseInt(match[1], 10)
        if (Number.isInteger(pid) && pid > 0) {
          pids.add(pid)
        }
      }
    } catch {
      // No process info available; nothing to kill.
    }
  }
  return [...pids]
}

export function killProcessesOnPorts(ports, ownPid = process.pid) {
  const pids = new Set()
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      if (pid !== ownPid) {
        pids.add(pid)
      }
    }
  }
  const targets = [...pids]
  if (targets.length === 0) {
    return false
  }
  console.log(`[dev] killing ${targets.length} process(es) bound to project ports: ${targets.join(', ')}`)
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5000
  let remaining = targets.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  while (remaining.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    remaining = remaining.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  }
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return true
}

export function killExistingProjectProcesses(ownPid = process.pid) {
  const pids = getProjectPids(ownPid)
  if (pids.length === 0) {
    return false
  }
  console.log(`[dev] cleaning up ${pids.length} existing project process(es): ${pids.join(', ')}`)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + 5000
  let remaining = pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  while (remaining.length > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    remaining = remaining.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  }
  if (remaining.length > 0) {
    console.warn(`[dev] unable to kill ${remaining.length} process(es): ${remaining.join(', ')}`)
  }
  return true
}

export async function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const { createConnection } = await import('node:net')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const available = await new Promise((resolve) => {
      const socket = createConnection(port, host)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (available) {
      return true
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  return false
}

export function projectPorts() {
  return [...PROJECT_PORTS]
}

export function optionalPorts() {
  return [...OPTIONAL_PORTS]
}

export function allProjectPorts() {
  return [...PROJECT_PORTS, ...OPTIONAL_PORTS]
}

export function runProjectCheck() {
  const inUseProject = portsInUse(PROJECT_PORTS)
  const inUseOptional = portsInUse(OPTIONAL_PORTS)
  if (inUseProject.length > 0 || inUseOptional.length > 0) {
    console.log('[dev] port check:')
    for (const port of inUseProject) {
      console.log(`  port ${port} in use (project)`)
    }
    for (const port of inUseOptional) {
      console.log(`  port ${port} in use (optional)`)
    }
  } else {
    console.log('[dev] project ports available')
  }
  return { project: inUseProject, optional: inUseOptional }
}
