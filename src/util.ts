import * as fs from 'node:fs'
import * as os from 'node:os'
import process from 'node:process'
import * as coc from 'coc.nvim'
import { HttpsProxyAgent } from 'https-proxy-agent'

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.promises.stat(filePath)
    return true
  } catch {
    return false
  }
}

export const ensureDirectory = async (directory: string): Promise<void> => {
  await fs.promises.mkdir(directory, { recursive: true })
}

export const executableName = (): string => (os.platform() === 'win32' ? 'stylua.exe' : 'stylua')

/** Reads the conventional proxy environment variables, lower case first. */
export const proxyAgent = (): HttpsProxyAgent<string> | undefined => {
  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  return proxy ? new HttpsProxyAgent<string>(proxy) : undefined
}

export const getConfiguration = (): coc.WorkspaceConfiguration => coc.workspace.getConfiguration('stylua')

export const getDesiredVersion = (): string =>
  (getConfiguration().get<string>('releaseVersion') ?? '').trim() || 'latest'

const getOptionalString = (key: string): string | undefined => {
  const value = getConfiguration().get<string | null>(key)
  const trimmed = value?.trim()
  return trimmed || undefined
}

export const getConfiguredStyluaPath = (): string | undefined => getOptionalString('styluaPath')

export const getConfiguredConfigPath = (): string | undefined => getOptionalString('configPath')

/** The formatting options listed by `stylua -h`, forwarded to `stylua --lsp` as CLI arguments. */
export const getFormatOptions = (): string[] => {
  const value = getConfiguration().get<string | string[]>('formatOptions')
  if (Array.isArray(value)) {
    return value.map(option => String(option).trim()).filter(Boolean)
  }
  // A space separated string is accepted as an alternative spelling, e.g. `--indent-width 4`.
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

export const shouldCheckForUpdates = (): boolean => getConfiguration().get<boolean>('checkUpdate', true)

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
