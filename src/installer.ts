import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import * as coc from 'coc.nvim'
import * as semver from 'semver'
import { getStyluaVersion } from './stylua'
import {
  ensureDirectory,
  errorMessage,
  executableName,
  fileExists,
  getConfiguration,
  getDesiredVersion,
  getOptionalString,
} from './util'

const RELEASES_API = 'https://api.github.com/repos/JohnnyMorganz/StyLua/releases'
const USER_AGENT = 'coc-stylua'
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/vnd.github+json',
}
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

const requestJson = async <T>(url: string): Promise<T> =>
  (await coc.fetch(url, { headers: REQUEST_HEADERS, timeout: REQUEST_TIMEOUT })) as T

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
  } catch {
    // Partial versions such as `v2.5` are not real tags, fall back to prefix matching below.
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

const installStylua = async (storageDirectory: string, version: string): Promise<string> =>
  coc.window.withProgress({ title: `Installing StyLua (${version})`, cancellable: false }, async (progress) => {
    progress.report({ message: 'Resolving release...' })
    const release = await getRelease(version)
    const asset = selectAsset(release)

    await ensureDirectory(storageDirectory)
    const target = path.join(storageDirectory, executableName())
    progress.report({ message: `Downloading ${asset.name}...` })
    await coc.download(asset.browser_download_url, {
      dest: storageDirectory,
      extract: 'unzip',
      timeout: DOWNLOAD_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT },
      onProgress: percent => progress.report({ message: `Downloading ${asset.name} (${percent}%)` }),
    })

    if (!(await fileExists(target))) {
      throw new Error(`The downloaded archive ${asset.name} does not contain ${executableName()}`)
    }
    await fs.promises.chmod(target, 0o755).catch(() => undefined)

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
    if (!getConfiguration().get<boolean>('checkUpdate', true)) {
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
  const configured = getOptionalString('styluaPath')
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
