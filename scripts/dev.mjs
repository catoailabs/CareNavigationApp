import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

if (process.env.PROVIDER_BROWSER_AUTOSTART !== '0') {
  startTransient('dev:browser', 'browser')
}

start('dev:app', 'app')
start('dev:agent', 'agent')
