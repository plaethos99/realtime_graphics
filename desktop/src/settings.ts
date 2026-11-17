import { getCurrentWindow } from '@tauri-apps/api/window';
import { ProxyClient } from '@rtg';
import { native, prettyShortcut, type Settings } from './native';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const fields = {
  proxyUrl: $<HTMLInputElement>('proxyUrl'),
  token: $<HTMLInputElement>('token'),
  talkShortcut: $<HTMLInputElement>('talkShortcut'),
  typeShortcut: $<HTMLInputElement>('typeShortcut'),
  speak: $<HTMLInputElement>('speak'),
  voice: $<HTMLSelectElement>('voice'),
};
const testResult = $<HTMLSpanElement>('test-result');
const errorEl = $<HTMLParagraphElement>('error');
const savedEl = $<HTMLSpanElement>('saved');

// Shortcut boxes show friendly text but keep the Tauri accelerator in data-value.
function setShortcut(input: HTMLInputElement, value: string): void {
  input.dataset.value = value;
  input.value = prettyShortcut(value);
}

function read(): Settings {
  return {
    proxyUrl: fields.proxyUrl.value.trim(),
    token: fields.token.value.trim(),
    talkShortcut: fields.talkShortcut.dataset.value ?? '',
    typeShortcut: fields.typeShortcut.dataset.value ?? '',
    speak: fields.speak.checked,
    voice: fields.voice.value,
  };
}

function fill(s: Settings): void {
  fields.proxyUrl.value = s.proxyUrl;
  fields.token.value = s.token;
  setShortcut(fields.talkShortcut, s.talkShortcut);
  setShortcut(fields.typeShortcut, s.typeShortcut);
  fields.speak.checked = s.speak;
  ensureVoiceOption(s.voice);
  fields.voice.value = s.voice;
}

function ensureVoiceOption(name: string): void {
  if (name && ![...fields.voice.options].some((o) => o.value === name)) fields.voice.add(new Option(name, name));
}

// ---------- shortcut recorder ----------

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

for (const input of [fields.talkShortcut, fields.typeShortcut]) {
  input.addEventListener('focus', () => {
    input.classList.add('recording');
    input.value = 'Press keys…';
  });
  input.addEventListener('blur', () => {
    input.classList.remove('recording');
    input.value = prettyShortcut(input.dataset.value ?? '');
  });
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') return input.blur();
    if (MODIFIER_CODES.has(e.code)) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    const isFunctionKey = /^F\d{1,2}$/.test(e.code);
    if (!mods.length && !isFunctionKey) {
      input.value = 'Add Ctrl, Alt, Shift or Win/Cmd';
      return;
    }
    setShortcut(input, [...mods, e.code].join('+'));
    input.blur();
  });
}

// ---------- proxy test and voices ----------

async function loadVoices(client: ProxyClient): Promise<void> {
  const url = new URL('voices', client.baseUrl.replace(/\/*$/, '/'));
  url.searchParams.set('locale', 'en');
  const res = await fetch(url, { headers: client.token ? { 'X-App-Token': client.token } : {} });
  if (!res.ok) return;
  const voices: { name: string; gender: string }[] = await res.json();
  const current = fields.voice.value;
  for (const v of voices) ensureVoiceOption(v.name);
  fields.voice.value = current;
}

$<HTMLButtonElement>('test').addEventListener('click', async () => {
  const { proxyUrl, token } = read();
  const client = new ProxyClient(proxyUrl, token);
  testResult.className = 'hint';
  testResult.textContent = 'Checking…';
  try {
    const h = await client.health(AbortSignal.timeout(5000));
    testResult.className = 'hint ok';
    testResult.textContent = h.mock
      ? 'Connected, but the proxy is in mock mode (no DeepSeek key).'
      : `Connected · ${h.model}${h.stt ? '' : ' · voice input off (no Groq key)'}`;
    loadVoices(client).catch(() => {});
  } catch {
    testResult.className = 'hint bad';
    testResult.textContent = `Can't reach ${proxyUrl}.`;
  }
});

// ---------- save / close ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  savedEl.textContent = '';
  try {
    await native.saveSettings(read());
    savedEl.textContent = 'Saved.';
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.hidden = false;
  }
});

$<HTMLButtonElement>('close').addEventListener('click', () => getCurrentWindow().close());

native.getSettings().then((s) => {
  fill(s);
  loadVoices(new ProxyClient(s.proxyUrl, s.token)).catch(() => {});
});
