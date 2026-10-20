/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

/** The prompt every native chooser shows. */
const DIALOG_TITLE = 'Select Workspace Directory'

/** The prompt the document chooser shows. */
const DOCUMENT_DIALOG_TITLE = 'Select Workspace Document'

/**
 * macOS panel source, run by the system JXA host (`osascript -l JavaScript`).
 *
 * A native panel resolves ⌘C/⌘V/⌘A/⌘X as main-menu key equivalents rather than
 * as focused-field behavior, so the script installs that menu before opening
 * `NSOpenPanel`; AppleScript's `choose folder` runs in a helper that has no
 * menu, which leaves every text field of its panel (Go to Folder, Search,
 * Tags) un-pastable. Menu items stay untargeted, so AppKit enables them
 * against the responder chain that owns the panel's field editor. The prompt
 * arrives as argv, never as executable source, and a cancel prints an empty
 * line instead of failing. A cancelled panel still reports its highlighted or
 * current directory in `URLs`, so only an OK response reads the selection.
 */
const MAC_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  app.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.message = argv[0];
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

/**
 * macOS document panel source: the same JXA `NSOpenPanel` host as
 * {@link MAC_PANEL}, but choosing files, optionally restricted to the given
 * extensions (argv[1], comma-joined; empty means any file). An unresolvable
 * extension makes AppKit reject the panel at runModal, so the caller retries
 * once without the filter.
 */
const MAC_DOCUMENT_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  app.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.allowsMultipleSelection = false;
  panel.message = argv[0];
  if (argv.length > 1 && argv[1] !== '') panel.allowedFileTypes = argv[1].split(',');
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, DIALOG_TITLE], signal, 'hidden')
    return outputPath(result.stdout)
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return await pickDialog(signal)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', `--title=${DIALOG_TITLE}`,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', DIALOG_TITLE,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}

/**
 * Open the platform document picker, restricted to `extensions` where the
 * platform dialog supports it. Windows has no document variant here (the
 * koffi dialog is directory-only), so it rejects as unsupported and the
 * caller falls back to a typed path.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param extensions - file extensions without the dot; empty means any file.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDocument(
  signal: AbortSignal,
  extensions: readonly string[] = [],
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    const filter = extensions.join(',')
    if (filter !== '') {
      try {
        const result = await run(
          'osascript', ['-l', 'JavaScript', '-e', MAC_DOCUMENT_PANEL, DOCUMENT_DIALOG_TITLE, filter], signal, 'hidden',
        )
        return outputPath(result.stdout)
      } catch (error: unknown) {
        // An extension AppKit cannot resolve rejects the panel; retry without
        // the filter rather than losing the chooser entirely.
        rethrowIfAborted(signal, error)
      }
    }
    const result = await run(
      'osascript', ['-l', 'JavaScript', '-e', MAC_DOCUMENT_PANEL, DOCUMENT_DIALOG_TITLE], signal, 'hidden',
    )
    return outputPath(result.stdout)
  }

  if (platform === 'linux') {
    const filters = extensions.length === 0
      ? []
      : [`--file-filter=Workspace documents | ${extensions.map(extension => `*.${extension}`).join(' ')}`]
    try {
      const result = await run('zenity', [
        '--file-selection', `--title=${DOCUMENT_DIALOG_TITLE}`, ...filters,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native document picker found (install zenity)')
      }
      throw error
    }
  }

  throw new Error(`native document picker is unsupported on ${platform}`)
}
