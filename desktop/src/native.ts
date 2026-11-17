// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from '@tauri-apps/api/core';
import { openUrl as openWithSystem } from '@tauri-apps/plugin-opener';

export interface Settings {
  proxyUrl: string;
  token: string;
  talkShortcut: string;
  typeShortcut: string;
  speak: boolean;
  voice: string;
}

export const isMac = navigator.userAgent.includes('Mac');

/** False when the page is opened in a normal browser (for testing). */
export const isTauri = '__TAURI_INTERNALS__' in window;

/** "CommandOrControl+Shift+KeyK" → "Ctrl + Shift + K" (or "Cmd" on macOS). */
export function prettyShortcut(s: string): string {
  return s
    .replace(/CommandOrControl|CmdOrCtrl/i, isMac ? 'Cmd' : 'Ctrl')
    .replace(/Super/i, isMac ? 'Cmd' : 'Win')
    .replace(/Key([A-Z])/g, '$1')
    .replace(/Digit(\d)/g, '$1')
    .split('+')
    .join(' + ');
}

/** Open a web address in the default browser (a new tab when running in a browser). */
export async function openUrl(url: string): Promise<void> {
  if (isTauri) await openWithSystem(url);
  else window.open(url, '_blank', 'noopener');
}

export const native = {
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  captureScreen: async (): Promise<Blob> => new Blob([await invoke<ArrayBuffer>('capture_screen')], { type: 'image/jpeg' }),
  cursorPosition: () => invoke<[number, number] | null>('cursor_position'),
  setEscape: (enabled: boolean) => invoke<void>('set_escape', { enabled }),
  openSettings: () => invoke<void>('open_settings'),
  openLibrary: (book?: string) => invoke<void>('open_library', { book: book ?? null }),
  /** Start recording the computer's sound (and the mic for meetings); returns warnings. */
  startRecording: (mode: 'watch' | 'meeting') => invoke<string[]>('start_recording', { mode }),
  stopRecording: () => invoke<void>('stop_recording'),
};
