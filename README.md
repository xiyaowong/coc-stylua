# coc-stylua

[StyLua](https://github.com/JohnnyMorganz/StyLua) for coc.nvim.

## Install

```
:CocInstall coc-stylua
```

## Usage

- Just run coc's formatting commands.
- Add `"lua"` to `coc.preferences.formatOnSaveFiletypes` to format on save.

## Settings

- `stylua.releaseVersion`: version to install, `latest` by default.
- `stylua.styluaPath`: path to a StyLua binary. When set, no download happens.
- `stylua.configPath`: path to a `stylua.toml`.
- `stylua.formatOptions`: extra arguments for `stylua --lsp`, e.g. `["--indent-width", "4"]`. See
  `stylua -h` for the available FORMATTING OPTIONS. They override `stylua.toml`.
- `stylua.checkUpdate`: check for a newer release after startup.

## Commands

`:CocCommand stylua.reinstall` installs StyLua again.

## License

MIT
