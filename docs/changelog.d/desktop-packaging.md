### Added

- **Windows has an extract-once ZIP download.** Extract the folder once and run `Covel.exe` from it; the installer remains the recommended download. The single-file self-extracting EXE remains available with a native preparation notice during extraction. See [installation](../start/install.md).

### Changed

- **Desktop packages carry fewer redundant files.** Bundled main-process dependencies are no longer copied again, and server staging removes the duplicate pnpm tree plus reviewed development-only files after compilation. TypeScript community plugins, native database support, authored content, locales and license notices are retained. This reduces payload size and file count; it does not establish a Windows startup-time improvement.
