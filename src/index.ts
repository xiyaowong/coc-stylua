import * as coc from 'coc.nvim';
import * as util from './util';
import { formatCode, checkIgnored } from './stylua';
import path from 'path';

/**
 * Convert a Position within a Document to a byte offset.
 * Required as `document.offsetAt(position)` returns a char offset, causing incosistencies when sending over to StyLua
 * @param document The document to retreive the byte offset in
 * @param position The possition to retreive the byte offset for
 */
const byteOffset = (document: coc.TextDocument, position: coc.Position) => {
  // Retreive all the text from the start of the document to the position provided
  const textRange = coc.Range.create(document.positionAt(0), position);
  const text = document.getText(textRange);

  // Retreive the byte length of the text range in a buffer
  return Buffer.byteLength(text);
};

export async function activate(context: coc.ExtensionContext) {
  console.log('stylua activated');

  let styluaBinaryPath: string | undefined = await util.ensureStyluaExists(context.storagePath);
  context.subscriptions.push(
    coc.commands.registerCommand('stylua.reinstall', async () => {
      await util.downloadStyLuaVisual(context.storagePath);
      styluaBinaryPath = await util.getStyluaPath(context.storagePath);
    })
  );

  context.subscriptions.push(
    coc.workspace.onDidChangeConfiguration(async (change) => {
      if (change.affectsConfiguration('stylua')) {
        styluaBinaryPath = await util.ensureStyluaExists(context.storagePath);
      }
    })
  );

  async function provideDocumentRangeFormattingEdits(
    document: coc.TextDocument,
    range: coc.Range
    /* options: coc.FormattingOptions,
      token: coc.CancellationToken */
  ) {
    if (!styluaBinaryPath) {
      coc.window.showErrorMessage('StyLua not found. Could not format file', 'Install').then((option) => {
        if (option === 'Install') {
          util.downloadStyLuaVisual(context.storagePath);
        }
      });
      return [];
    }

    const currentWorkspace = coc.workspace.getWorkspaceFolder(document.uri);
    let cwd = currentWorkspace?.uri;
    if (cwd) {
      cwd = path.normalize(coc.Uri.parse(cwd).fsPath);
    }

    if (await checkIgnored(document.uri, currentWorkspace?.uri)) {
      return [];
    }

    const text = document.getText();

    try {
      const formattedText = await formatCode(
        styluaBinaryPath,
        text,
        cwd,
        byteOffset(document, range.start),
        byteOffset(document, range.end)
      );
      if (!formattedText.length) return;
      // Replace the whole document with our new formatted version
      const lastLineNumber = document.lineCount - 1;
      const doc = coc.workspace.getDocument(document.uri);
      const fullDocumentRange = coc.Range.create(
        { line: 0, character: 0 },
        { line: lastLineNumber, character: doc.getline(lastLineNumber).length }
      );
      const format = coc.TextEdit.replace(fullDocumentRange, formattedText);
      return [format];
    } catch (err) {
      coc.window.showErrorMessage(`Could not format file: ${err}`);
      return [];
    }
  }

  async function provideDocumentFormattingEdits(document: coc.TextDocument) {
    const doc = coc.workspace.getDocument(document.uri);
    const lastLine = doc.lineCount - 1;
    const range = coc.Range.create(
      { character: 0, line: 0 },
      { character: doc.getline(lastLine).length, line: lastLine }
    );
    return await provideDocumentRangeFormattingEdits(document, range);
  }

  context.subscriptions.push(
    coc.languages.registerDocumentRangeFormatProvider(['lua'], { provideDocumentRangeFormattingEdits }, 999),
    coc.languages.registerDocumentFormatProvider(['lua'], { provideDocumentFormattingEdits }, 999)
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}
