import * as coc from 'coc.nvim'
import { getFormatOptions, getOptionalString } from './util'

export const CLIENT_ID = 'stylua'

const DOCUMENT_SELECTOR: coc.DocumentSelector = ['lua', 'luau']

const serverArguments = (): string[] => {
  const configPath = getOptionalString('configPath')
  const args = ['--lsp']
  if (configPath) {
    args.push('--config-path', configPath)
  }
  // Formatting options win over both `stylua.toml` and `--config-path`.
  args.push(...getFormatOptions())
  return args
}

export const createStyluaClient = (command: string): coc.LanguageClient =>
  new coc.LanguageClient(
    CLIENT_ID,
    'StyLua',
    { command, args: serverArguments() },
    {
      documentSelector: DOCUMENT_SELECTOR,
      outputChannelName: 'stylua',
      formatterPriority: 999,
      // StyLua owns the formatting configuration: `stylua.toml` decides indentation instead of the editor.
      initializationOptions: { respect_editor_formatting_options: false },
    },
  )
