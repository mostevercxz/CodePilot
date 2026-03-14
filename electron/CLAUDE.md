[Root](../CLAUDE.md) > **electron**

# Electron Shell Module

## Module Role

Electron main process providing the desktop shell for CodePilot. Manages the BrowserWindow, embeds the Next.js standalone server as a UtilityProcess (production) or connects to the dev server, handles IPC for native features, and provides auto-update capability.

## Entry and Startup

- **Main process**: `electron/main.ts` -- app lifecycle, window creation, server management
- **Preload**: `electron/preload.ts` -- contextBridge exposing install API and updater API to renderer
- **Updater**: `electron/updater.ts` -- electron-updater integration for auto-updates
- **Terminal**: `electron/terminal-manager.ts` -- PTY terminal management for embedded terminal feature
- **Build config**: `electron/tsconfig.json` -- TypeScript config for esbuild compilation

## External Interfaces

### IPC Channels (main <-> renderer)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `install:*` | bidirectional | Install wizard orchestration (Claude CLI install steps) |
| `updater:*` | main -> renderer | Auto-update status, download progress |
| `terminal:*` | bidirectional | Terminal creation, input/output, resize |
| `open-external` | renderer -> main | Open URLs in system browser via shell.openExternal |
| `select-folder` | renderer -> main | Native folder picker dialog |

### Server Lifecycle

- **Dev mode**: Connects to `http://localhost:3000` (Next.js dev server)
- **Production**: Spawns Next.js standalone server via `utilityProcess.fork()`, finds a free port, loads the app once server is ready
- Sanitizes `__NEXT_PRIVATE_*` env vars to avoid polluting child processes

## Key Dependencies and Configuration

- `electron`: ^40.2.1
- `electron-updater`: ^6.8.3
- `electron-builder`: ^26.7.0 (dev)
- Builder config: `electron-builder.yml` (root)
- After-pack script: `scripts/after-pack.js` (recompiles better-sqlite3 for Electron ABI)
- After-sign script: `scripts/after-sign.js`

## Build Pipeline

```
esbuild (scripts/build-electron.mjs)
  -> bundles electron/main.ts -> dist-electron/main.js
  -> bundles electron/preload.ts -> dist-electron/preload.js
electron-builder (electron-builder.yml)
  -> packages standalone Next.js + dist-electron -> DMG/NSIS/AppImage
```

## Data Model

No direct database access. All data operations go through the Next.js API layer. The main process manages:
- Window state (position, size)
- Install wizard state (in-memory `InstallState`)
- System tray (Tray + Menu)
- Server process lifecycle

## Tests and Quality

No dedicated unit tests for the Electron module. Tested indirectly via E2E (Playwright) and manual verification.

## Related Files

- `electron/main.ts` -- Main process entry
- `electron/preload.ts` -- Context bridge
- `electron/updater.ts` -- Auto-updater
- `electron/terminal-manager.ts` -- Terminal PTY manager
- `electron/tsconfig.json` -- TypeScript config
- `electron-builder.yml` -- Packaging config (root)
- `scripts/build-electron.mjs` -- esbuild script
- `scripts/after-pack.js` -- Native module recompilation
- `scripts/after-sign.js` -- Code signing hook

## Changelog

| Date | Action |
|------|--------|
| 2026-03-14 | Initial documentation from architecture scan |
