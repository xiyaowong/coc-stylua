// Based off https://github.com/Kampfkarren/selene/blob/master/selene-vscode/src/util.ts
// Licensed under https://github.com/Kampfkarren/selene/blob/master/LICENSE.md
import * as coc from 'coc.nvim';
import * as fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import * as os from 'os';
import path from 'path';
import * as semver from 'semver';
import * as unzip from 'unzipper';
import { executeStylua } from './stylua';

const RELEASES_URL = 'https://api.github.com/repos/JohnnyMorganz/StyLua/releases';

const agent = () => (process.env.https_proxy ? new HttpsProxyAgent(process.env.https_proxy as string) : null);

type GithubRelease = {
  assets: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    browser_download_url: string;
    name: string;
  }[];
  // eslint-disable-next-line @typescript-eslint/naming-convention
  tag_name: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  html_url: string;
};

const getRelease = async (version: string): Promise<GithubRelease> => {
  if (version === 'latest') {
    // @ts-ignore
    return await (await fetch(RELEASES_URL + '/latest', { agent: agent(), timeout: 10e3 })).json();
  }

  version = version.startsWith('v') ? version : 'v' + version;
  const releases: GithubRelease[] = await (await fetch(RELEASES_URL)).json();
  for (const release of releases) {
    if (release.tag_name.startsWith(version)) {
      return release;
    }
  }

  throw new Error(`No release version matches ${version}.`);
};

const getDownloadOutputFilename = () => {
  switch (os.platform()) {
    case 'win32':
      return 'stylua.exe';
    case 'linux':
    case 'darwin':
      return 'stylua';
    default:
      throw new Error('platform not supported');
  }
};

const getAssetFilenamePattern = () => {
  switch (os.platform()) {
    case 'win32':
      return /stylua(-[\d\w\-\.]+)?-win64.zip/;
    case 'linux':
      return /stylua(-[\d\w\-\.]+)?-linux.zip/;
    case 'darwin':
      return /stylua(-[\d\w\-\.]+)?-macos.zip/;
    default:
      throw new Error('Platform not supported');
  }
};

const getDesiredVersion = (): string => {
  const config = coc.workspace.getConfiguration('stylua');
  const targetVersion = config.get<string>('targetReleaseVersion', '').trim();
  if (targetVersion.length === 0) {
    return config.get<string>('releaseVersion', 'latest');
  }
  return targetVersion;
};

export const fileExists = async (path: coc.Uri | string): Promise<boolean> => {
  const uri = path instanceof coc.Uri ? path : coc.Uri.file(path);
  return fs.promises.stat(uri.fsPath).then(
    () => true,
    () => false
  );
};

const downloadStylua = async (outputDirectory: string) => {
  const version = getDesiredVersion();
  const release = await getRelease(version);
  const assetFilename = getAssetFilenamePattern();
  const outputFilename = getDownloadOutputFilename();

  for (const asset of release.assets) {
    if (assetFilename.test(asset.name)) {
      const file = fs.createWriteStream(path.join(outputDirectory, outputFilename), {
        mode: 0o755,
      });

      return new Promise(async (resolve, reject) => {
        fetch(asset.browser_download_url, {
          headers: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'User-Agent': 'stylua-vscode',
          },
          timeout: 10e3,
          // @ts-ignore
          agent: agent(),
        })
          .then((res) => res.body.pipe(unzip.Parse()))
          .then((stream) => {
            stream.on('entry', (entry: unzip.Entry) => {
              if (entry.path !== outputFilename) {
                entry.autodrain();
                return;
              }

              entry.pipe(file).on('finish', resolve).on('error', reject);
            });
          });
      });
    }
  }
};

export const downloadStyLuaVisual = (outputDirectory: string) => {
  return coc.window.withProgress(
    {
      title: 'Downloading StyLua',
      cancellable: false,
    },
    () => downloadStylua(outputDirectory)
  );
};

export const getStyluaPath = async (storageDirectory: string): Promise<string | undefined> => {
  const settingPath = coc.workspace.getConfiguration('stylua').get<string | null>('styluaPath');
  if (settingPath) {
    return settingPath;
  }

  const downloadPath = path.join(storageDirectory, getDownloadOutputFilename());
  if (await fileExists(downloadPath)) {
    return downloadPath;
  }
};

export const ensureStyluaExists = async (storageDirectory: string): Promise<string | undefined> => {
  const path = await getStyluaPath(storageDirectory);

  if (path === undefined) {
    if (!fileExists(storageDirectory.toString())) await fs.promises.mkdir(storageDirectory.toString());
    await downloadStyLuaVisual(storageDirectory);
    return await getStyluaPath(storageDirectory);
  } else {
    if (!(await fileExists(path))) {
      coc.window.showErrorMessage(`The path given for StyLua (${path}) does not exist`);
      return;
    }

    const config = coc.workspace.getConfiguration('stylua');
    const checkUpdate = config.get<boolean>('checkUpdate', true);
    try {
      const currentVersion = (await executeStylua(path, ['--version']))?.trim().split(' ')[1];
      const desiredVersion = getDesiredVersion();
      if (!checkUpdate) {
        // Do not check stylua update
        if (desiredVersion === 'latest' || semver.satisfies(currentVersion, desiredVersion)) {
          // Use current local version
          return path;
        }
        // Local version can't satisfy desied version, prompt to download it
      }
      let release: GithubRelease | undefined = undefined;
      try {
        release = await getRelease(desiredVersion);
      } catch (err) {
        console.error(err);
      }
      if (release) {
        if (currentVersion !== (release.tag_name.startsWith('v') ? release.tag_name.substr(1) : release.tag_name)) {
          openUpdatePrompt(storageDirectory, release);
        }
      }
    } catch (err) {
      coc.window.showWarningMessage(
        `Error checking the selected StyLua version, falling back to the currently installed version:\n${err}`
      );
    }

    return path;
  }
};

function openUpdatePrompt(directory: string, release: GithubRelease) {
  coc.window
    .showInformationMessage(`StyLua ${release.tag_name} is available to install.`, 'Install', 'Later')
    .then((option) => {
      switch (option) {
        case 'Install':
          downloadStyLuaVisual(directory);
          break;
      }
    });
}
