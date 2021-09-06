import * as coc from 'coc.nvim';
import { spawn, exec } from 'child_process';
import ignore from 'ignore';
import { fileExists } from './util';
import path from 'path';

export async function checkIgnored(filePath?: string, currentWorkspace?: string): Promise<boolean> {
  if (!filePath || !currentWorkspace) {
    return false;
  }

  const ignoreFilePath = path.join(currentWorkspace, '.styluaignore');
  if (await fileExists(ignoreFilePath)) {
    try {
      const contents = await coc.workspace.readFile(ignoreFilePath);
      const ig = ignore().add(contents.toString());
      return ig.ignores(filePath.toString());
    } catch (err) {
      coc.window.showErrorMessage(`Could not read StyLua ignore file at ${ignoreFilePath}:\n${err}`);
      return false;
    }
  }

  return false;
}

export function formatCode(
  path: string,
  code: string,
  cwd?: string,
  startPos?: number,
  endPos?: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (startPos) {
      args.push('--range-start');
      args.push(startPos.toString());
    }
    if (endPos) {
      args.push('--range-end');
      args.push(endPos.toString());
    }
    args.push('-');

    const child = spawn(path, args, { cwd });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stdout.on('close', () => {
      resolve(output.trimEnd());
    });
    child.stderr.on('data', (data) => reject(data.toString()));
    child.on('err', () => reject('Failed to start StyLua'));

    // Write our code to stdin
    child.stdin.write(code);
    child.stdin.end();
  });
}

export function executeStylua(path: string, args?: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `"${path}" ${args?.join(' ') ?? ''}`,
      {
        cwd,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
        }
        resolve(stdout);
      }
    );
  });
}
