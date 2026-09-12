import * as fs from 'node:fs'
import * as os from 'node:os'
import * as coc from 'coc.nvim'

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

export const getConfiguration = (): coc.WorkspaceConfiguration => coc.workspace.getConfiguration('stylua')

export const getDesiredVersion = (): string =>
  (getConfiguration().get<string>('releaseVersion') ?? '').trim() || 'latest'

export const getOptionalString = (key: string): string | undefined => {
  const value = getConfiguration().get<string | null>(key)
  const trimmed = value?.trim()
  return trimmed || undefined
}

/** The formatting options listed by `stylua -h`, forwarded to `stylua --lsp` as CLI arguments. */
export const getFormatOptions = (): string[] => {
  const value = getConfiguration().get<string | string[]>('formatOptions')
  if (Array.isArray(value)) {
    return value.map(option => String(option).trim()).filter(Boolean)
  }
  // A space separated string is accepted as an alternative spelling, e.g. `--indent-width 4`.
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
