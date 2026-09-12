import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import AdmZip from 'adm-zip'
import * as coc from 'coc.nvim'
import fetch from 'node-fetch'
import * as semver from 'semver'
import { getStyluaVersion } from './stylua'
import {
  ensureDirectory,
  errorMessage,
  executableName,
  fileExists,
  getConfiguredStyluaPath,
  getDesiredVersion,
  proxyAgent,
  shouldCheckForUpdates,
} from './util'

const RELEASES_API = 'https://api.github.com/repos/JohnnyMorganz/StyLua/releases'
const USER_AGENT = 'coc-stylua'
const REQUEST_TIMEOUT = 30_000
const DOWNLOAD_TIMEOUT = 300_000
const PAGE_SIZE = 100
const MAX_PAGES = 10

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface StyluaRelease {
  tag_name: string
  html_url: string
  assets: ReleaseAsset[]
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const requestJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    agent: proxyAgent(),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  if (!response.ok) {
    throw new HttpError(response.status, `Request to ${url} failed with ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

const normalizeTag = (version: string): string => (version.startsWith('v') ? version : `v${version}`)

const listReleases = async (): Promise<StyluaRelease[]> => {
  const releases: StyluaRelease[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await requestJson<StyluaRelease[]>(`${RELEASES_API}?per_page=${PAGE_SIZE}&page=${page}`)
    releases.push(...batch)
    if (batch.length < PAGE_SIZE) {
      break
    }
  }
  return releases
}

const getRelease = async (version: string): Promise<StyluaRelease> => {
  if (version === 'latest') {
    return requestJson<StyluaRelease>(`${RELEASES_API}/latest`)
  }

  const tag = normalizeTag(version)
  try {
    return await requestJson<StyluaRelease>(`${RELEASES_API}/tags/${encodeURIComponent(tag)}`)
  } catch (error) {
    // Partial versions such as `v2.5` are not real tags, fall back to prefix matching below.
    if (!(error instanceof HttpError) || error.status !== 404) {
      throw error
    }
  }

  const releases = await listReleases()
  const release
    = releases.find(item => item.tag_name === tag) ?? releases.find(item => item.tag_name.startsWith(`${tag}.`))
  if (!release) {
    throw new Error(`No StyLua release matches "${version}"`)
  }
  return release
}

const PLATFORM_TOKENS: Record<string, RegExp> = {
  win32: /(windows|win64|win32)/i,
  linux: /linux/i,
  darwin: /(macos|darwin)/i,
}

const ARCH_TOKENS: Record<string, RegExp> = {
  x64: /(x86_64|x64|amd64)/i,
  arm64: /(aarch64|arm64)/i,
}

/**
 * Scores an asset name, `0` meaning "not usable on this machine".
 * Release asset names changed over time, e.g. `stylua-v0.15.3-win64.zip` became `stylua-windows-x86_64.zip`,
 * so this matches on tokens instead of an exact list.
 */
const assetScore = (name: string): number => {
  if (!/^stylua.*\.zip$/i.test(name) || /musl/i.test(name)) {
    return 0
  }

  const platform = PLATFORM_TOKENS[os.platform()]
  if (!platform?.test(name)) {
    return 0
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (ARCH_TOKENS[arch].test(name)) {
    return 3
  }
  // A universal build runs as-is, a foreign arch only through emulation.
  return ARCH_TOKENS[arch === 'x64' ? 'arm64' : 'x64'].test(name) ? 1 : 2
}

const selectAsset = (release: StyluaRelease): ReleaseAsset => {
  let selected: { asset: ReleaseAsset, score: number } | undefined
  for (const asset of release.assets) {
    const score = assetScore(asset.name)
    if (score > 0 && (!selected || score > selected.score)) {
      selected = { asset, score }
    }
  }

  if (!selected) {
    const available = release.assets.map(asset => asset.name).join(', ') || '(none)'
    throw new Error(
      `No StyLua asset for ${os.platform()}-${process.arch} in release ${release.tag_name}: ${available}`,
    )
  }
  return selected.asset
}

const downloadAsset = async (asset: ReleaseAsset): Promise<Buffer> => {
  const response = await fetch(asset.browser_download_url, {
    agent: proxyAgent(),
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  })
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Failed to download ${asset.name}: ${response.status} ${response.statusText}`,
    )
  }

  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length === 0) {
    throw new Error(`The downloaded archive ${asset.name} is empty`)
  }
  return archive
}

const extractExecutable = (archive: Buffer, entryName: string): Buffer => {
  const entries = new AdmZip(archive).getEntries()
  const entry = entries.find(item => path.posix.basename(item.entryName) === entryName)
  if (!entry) {
    const available = entries.map(item => item.entryName).join(', ') || '(none)'
    throw new Error(`The downloaded archive does not contain ${entryName}: ${available}`)
  }

  const contents = entry.getData()
  if (contents.length === 0) {
    throw new Error(`${entryName} is empty inside the downloaded archive`)
  }
  return contents
}

/** Writes to a sibling file first, so a partial or unusable download can never look installed. */
const writeExecutable = async (target: string, contents: Buffer): Promise<void> => {
  const temporary = `${target}.download`
  try {
    await fs.promises.writeFile(temporary, contents, { mode: 0o755 })
    await fs.promises.rm(target, { force: true })
    await fs.promises.rename(temporary, target)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await fs.promises.chmod(target, 0o755).catch(() => undefined) // no-op on Windows
}

const installStylua = async (storageDirectory: string, version: string): Promise<string> =>
  coc.window.withProgress({ title: `Installing StyLua (${version})`, cancellable: false }, async (progress) => {
    progress.report({ message: 'Resolving release...' })
    const release = await getRelease(version)
    const asset = selectAsset(release)

    progress.report({ message: `Downloading ${asset.name}...` })
    const archive = await downloadAsset(asset)

    progress.report({ message: 'Extracting...' })
    const contents = extractExecutable(archive, executableName())

    await ensureDirectory(storageDirectory)
    const target = path.join(storageDirectory, executableName())
    await writeExecutable(target, contents)

    progress.report({ message: 'Verifying...' })
    if (!(await getStyluaVersion(target))) {
      await fs.promises.rm(target, { force: true }).catch(() => undefined)
      throw new Error(`The downloaded binary (${release.tag_name}) could not be executed`)
    }
    return target
  })

export const reinstallStylua = async (storageDirectory: string): Promise<string | undefined> => {
  try {
    const installed = await installStylua(storageDirectory, getDesiredVersion())
    coc.window.showInformationMessage(`StyLua installed at ${installed}`)
    return installed
  } catch (error) {
    coc.window.showErrorMessage(`Failed to install StyLua: ${errorMessage(error)}`)
    return undefined
  }
}

const promptForUpdate = async (storageDirectory: string, release: StyluaRelease): Promise<void> => {
  const choice = await coc.window.showInformationMessage(
    `StyLua ${release.tag_name} is available to install.`,
    'Install',
    'Later',
  )
  if (choice === 'Install') {
    await reinstallStylua(storageDirectory)
  }
}

const checkForUpdate = async (storageDirectory: string, currentVersion: string): Promise<void> => {
  const desired = getDesiredVersion()
  if (desired === 'latest') {
    if (!shouldCheckForUpdates()) {
      return
    }
  } else if (semver.validRange(desired) && semver.satisfies(currentVersion, desired)) {
    // A version such as `2.5` is a release tag, not a semver range, and is resolved below instead.
    return
  }

  let release: StyluaRelease
  try {
    release = await getRelease(desired)
  } catch (error) {
    // Being offline must not prevent formatting with the binary that is already installed.
    console.warn(`coc-stylua: could not check for StyLua updates: ${errorMessage(error)}`)
    return
  }

  if (currentVersion !== release.tag_name.replace(/^v/, '')) {
    void promptForUpdate(storageDirectory, release)
  }
}

export const ensureStyluaExists = async (storageDirectory: string): Promise<string | undefined> => {
  const configured = getConfiguredStyluaPath()
  if (configured) {
    return configured
  }

  const installed = path.join(storageDirectory, executableName())
  if (await fileExists(installed)) {
    const version = await getStyluaVersion(installed)
    if (version) {
      void checkForUpdate(storageDirectory, version)
      return installed
    }
    coc.window.showWarningMessage('The installed StyLua binary could not be executed, installing it again...')
  }

  return reinstallStylua(storageDirectory)
}
