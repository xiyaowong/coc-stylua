import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

const run = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      reject(new Error(`Failed to run ${command}: ${error.message}`))
    })

    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code === 0) {
        resolve(output)
        return
      }
      const error = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(`${command} exited with code ${code}${error ? `: ${error}` : ''}`))
    })

    // A broken pipe is not interesting: the exit code is the authoritative result.
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })

export const getStyluaVersion = async (command: string): Promise<string | undefined> => {
  try {
    const output = await run(command, ['--version'])
    return output.match(/(\d+\.\d+\.\d[\w.+-]*)/)?.[1]
  } catch {
    return undefined
  }
}
