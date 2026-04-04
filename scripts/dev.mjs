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
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
    process.exit(code)
  }, 750).unref()
}

function start(script, name) {
  const child = spawn(npmCmd, ['run', script], {
    cwd: root,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
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

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

start('dev:app', 'app')
start('dev:runtime', 'runtime')
start('dev:agent', 'agent')
