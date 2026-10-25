import { Projector, EFFECTS, DEVICE_TYPES, DEFAULT_PASSWORD } from './blisslight.js';
import { macRevFromString } from './telink.js';
import { bluetoothSupport, safariLink, isIOS, BEACIO_URL, BLUEFY_URL } from './platform.js';

const $ = (id) => document.getElementById(id);

// Hand-made "artwork" for each effect tile; green dots stand in for the laser stars.
const STARS = 'radial-gradient(2px 2px at 20% 30%, #9f9 50%, transparent 51%), radial-gradient(2px 2px at 70% 22%, #9f9 50%, transparent 51%),' +
  'radial-gradient(1.5px 1.5px at 45% 55%, #bfb 50%, transparent 51%), radial-gradient(2px 2px at 82% 64%, #9f9 50%, transparent 51%),' +
  'radial-gradient(1.5px 1.5px at 30% 75%, #bfb 50%, transparent 51%), radial-gradient(2px 2px at 58% 82%, #9f9 50%, transparent 51%),';
const ART = {
  1: `${STARS} radial-gradient(circle at 35% 40%, #2b6cff 0, transparent 55%), radial-gradient(circle at 70% 70%, #19c9a7 0, transparent 50%), #060a24`,
  2: 'radial-gradient(circle at 50% 50%, #8a5cff 0, #2a1660 45%, #0a0620 80%)',
  3: `${STARS} radial-gradient(circle at 50% 50%, #0d1530, #04060f)`,
  4: 'radial-gradient(circle at 30% 35%, #3a7bff 0, transparent 50%), radial-gradient(circle at 70% 60%, #b055ff 0, transparent 55%), #0a0b2a',
  5: 'radial-gradient(circle at 40% 70%, #10d0e0 0, transparent 55%), radial-gradient(circle at 70% 30%, #1650ff 0, transparent 55%), #031530',
  6: `${STARS} radial-gradient(circle at 60% 40%, #4b2a9c 0, transparent 55%), #050414`,
  8: 'radial-gradient(circle at 50% 90%, #ffcf5a 0, #ff6a3d 30%, #a0307a 60%, #1a0b30 90%)',
  9: 'conic-gradient(from 30deg, #ff4d5e, #ffd447, #3ddc84, #3ec6ff, #7c5cff, #ff4dd2, #ff4d5e)',
};

const state = {
  projector: null,
  effect: null,        // current effect id, 0 = off, 'custom' = manual colours
  lastEffect: 1,
  config: null,
  light: { red: 0, green: 0, blue: 255, laser: 255, motor: 0, brightness: 3, fade: 0 },
};

let queue = Promise.resolve();
function run(fn) {
  // One command at a time, like the original app (it locked the UI until the projector replied).
  queue = queue.then(async () => {
    document.body.classList.add('busy');
    try { return await fn(); } catch (e) { toast(e.message || String(e)); } finally { document.body.classList.remove('busy'); }
  });
  return queue;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function pill(text, kind) {
  $('pill').textContent = text;
  $('pill').dataset.state = kind;
}

function log(msg) {
  const el = $('log');
  const lines = (el.textContent + msg + '\n').split('\n');
  el.textContent = lines.slice(-200).join('\n');
  el.scrollTop = el.scrollHeight;
}

function noReply(r) {
  if (!r) toast('No reply from the projector. It may still have worked.');
  return r;
}

// ---------- rendering ----------
function renderEffects() {
  const wrap = $('effects');
  wrap.replaceChildren(...EFFECTS.map((e) => {
    const b = document.createElement('button');
    b.className = 'effect';
    b.style.setProperty('--art', ART[e.id]);
    b.dataset.id = e.id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<span></span>';
    b.firstChild.textContent = e.name;
    b.addEventListener('click', () => playEffect(e.id));
    return b;
  }));
}

function render() {
  const eff = state.effect;
  const name = eff === 0 ? 'Off' : eff === 'custom' ? 'Custom' : EFFECTS.find((e) => e.id === eff)?.name ?? (eff >= 10 ? `DIY scene ${eff - 9}` : '—');
  $('nowName').textContent = name;
  $('powerBtn').classList.toggle('on', eff !== 0 && eff !== null);
  for (const b of $('effects').children) b.setAttribute('aria-pressed', String(Number(b.dataset.id) === eff));

  const L = state.light;
  for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(L[c.dataset.ch] > 0));
  const rgb = [L.red, L.green, L.blue].map((v) => (v ? 255 : 0));
  $('mixSwatch').style.background = rgb.some(Boolean) ? `rgb(${rgb})` : '#000';
  $('mixSwatch').style.boxShadow = rgb.some(Boolean) ? `0 0 18px rgb(${rgb})` : '';
  $('laser').checked = L.laser > 0;
  $('fade').checked = L.fade > 0;

  const motor = state.config ? state.config.motor : L.motor;
  const bright = state.config ? state.config.brightness : L.brightness;
  $('rotation').checked = motor > 0;
  for (const b of $('brightness').children) b.setAttribute('aria-checked', String(Number(b.dataset.v) === bright));
  if (state.config) {
    $('offTimer').value = String(state.config.offTime);
    $('cycle').value = String(state.config.isLoop ? state.config.loopTime : 0);
  }
}

function renderInfo(p, deviceType) {
  const mac = p.mac4 ? ['••', '••', ...Array.from(p.mac4).reverse().map((v) => v.toString(16).padStart(2, '0').toUpperCase())].join(':') : '?';
  const rows = [
    ['Model', deviceType == null ? 'unknown' : DEVICE_TYPES[deviceType] || `Sky Lite (type ${deviceType})`],
    ['Firmware', p.firmware || 'unknown'],
    ['Mesh name', p.meshName()],
    ['Address', mac],
  ];
  $('info').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------- actions ----------
function playEffect(id) {
  return run(async () => {
    noReply(await state.projector.effect(id));
    state.effect = id;
    state.lastEffect = id;
    if (state.config) { state.config.loopTime = 0; state.config.isLoop = 0; }
    render();
  });
}

function sendLight() {
  return run(async () => {
    const L = { ...state.light };
    if (state.config) { L.motor = state.config.motor; L.brightness = state.config.brightness; }
    noReply(await state.projector.setLight(L));
    state.effect = 'custom';
    render();
  });
}

async function refresh() {
  const p = state.projector;
  const type = await p.queryDeviceType();
  state.config = await p.queryConfig();
  const light = await p.queryLight();
  if (light) state.light = light;
  if (state.config) {
    state.effect = state.config.lastScene;
    if (state.config.lastScene) state.lastEffect = state.config.lastScene;
  }
  renderInfo(p, type);
  render();
}

// ---------- "your browser can't do Bluetooth" guidance ----------
const SUPPORT_HTML = {
  'ios-other-browser': `<strong>Open this page in Safari</strong>
    <p>On iPhone and iPad, Bluetooth only works in Safari (with the free beacio extension) or in the Bluefy browser.</p>
    <div class="notice-actions"><a class="btn primary" data-safari>Open in Safari</a><button class="btn" data-copy>Copy link</button></div>
    <p class="small">If the button does nothing, copy the link, open Safari and paste it into the address bar.</p>`,
  'ios-standalone': `<strong>Open this page in Safari</strong>
    <p>Home Screen apps can't use Safari extensions, so Bluetooth isn't available here.</p>
    <div class="notice-actions"><a class="btn primary" data-safari>Open in Safari</a><button class="btn" data-copy>Copy link</button></div>`,
  'ios-no-extension': `<strong>One-time setup for iPhone and iPad</strong>
    <ol>
      <li>Install <a href="${BEACIO_URL}" target="_blank" rel="noopener">beacio</a> from the App Store. It's free and adds Bluetooth to Safari (needs iOS 26.2 or later).</li>
      <li>Open <b>Settings → Apps → Safari → Extensions → beacio</b>, turn it on and choose <b>Allow on Every Website</b>.</li>
      <li>Come back to this page and reload.</li>
    </ol>
    <div class="notice-actions"><a class="btn primary" href="${BEACIO_URL}" target="_blank" rel="noopener">Get beacio</a><button class="btn" data-reload>Reload</button></div>
    <p class="small">Older iOS? Open this page in the free <a href="${BLUEFY_URL}" target="_blank" rel="noopener">Bluefy</a> browser instead. <button class="link" data-copy>Copy link</button></p>`,
  'ios-extension-off': `<strong>Allow beacio on this site</strong>
    <p>Tap the <b>aA</b> button in Safari's address bar → <b>Manage Extensions</b> → turn on <b>beacio</b>, then allow it on this website. Private tabs aren't supported.</p>
    <div class="notice-actions"><button class="btn primary" data-reload>Reload</button></div>`,
  'unsupported': `<strong>This browser can't use Bluetooth.</strong>
    <p>Open this page in <b>Chrome</b> or <b>Edge</b> on Android, Windows, Mac, Linux or ChromeOS.</p>
    <div class="notice-actions"><button class="btn" data-copy>Copy link</button></div>`,
  'bluetooth-off': `<strong>Bluetooth looks switched off.</strong>
    <p>Turn on Bluetooth on this device, then reload.</p>
    <div class="notice-actions"><button class="btn" data-reload>Reload</button></div>`,
};

function renderSupport(kind) {
  const el = $('unsupported');
  el.hidden = !SUPPORT_HTML[kind];
  if (el.hidden) return;
  el.className = kind.startsWith('ios') ? 'notice tip' : 'notice';
  el.innerHTML = SUPPORT_HTML[kind];
  for (const a of el.querySelectorAll('[data-safari]')) {
    const href = safariLink();
    if (href) a.href = href; else a.remove();
  }
  for (const b of el.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Link copied. Paste it into Safari.'); } catch { toast(location.href); }
    });
  }
  for (const b of el.querySelectorAll('[data-reload]')) b.addEventListener('click', () => location.reload());
  // Connecting can't work in these cases; keep the button but make it point at the instructions.
  const blocked = kind !== 'bluetooth-off';
  $('connectBtn').classList.toggle('primary', !blocked);
  $('showAllBtn').parentElement.hidden = blocked;
}

async function connect({ showAll = false } = {}) {
  // Must reach requestDevice() without awaiting anything first: Safari + beacio only allow it
  // directly inside the tap handler.
  if (!navigator.bluetooth) { renderSupport(await bluetoothSupport()); $('unsupported').scrollIntoView({ behavior: 'smooth' }); return; }
  showAll = showAll || isIOS(); // beacio doesn't document manufacturer-data filters
  const status = $('connectStatus');
  status.classList.remove('error');
  const p = new Projector();
  p.addEventListener('log', (e) => log(e.detail));
  p.addEventListener('status', (e) => { status.textContent = e.detail; pill(e.detail, 'busy'); });
  p.addEventListener('progress', (e) => {
    $('progress').hidden = e.detail === null;
    if (e.detail !== null) $('progress').firstChild.style.width = `${Math.round(e.detail * 100)}%`;
  });
  p.addEventListener('report', (e) => {
    const r = e.detail;
    if (r[0] === 0x49) { state.effect = r[3]; render(); }           // effect changed (cycle / button on the projector)
  });
  p.addEventListener('disconnected', () => {
    // Chrome reuses the BluetoothDevice object, so listeners from earlier sessions fire too.
    if (state.projector !== p) return;
    state.projector = null;
    pill('Disconnected', 'idle');
    $('controlView').hidden = true;
    $('connectView').hidden = false;
    status.textContent = 'Disconnected. Tap connect to reconnect.';
  });

  try {
    $('connectBtn').disabled = true;
    await p.pick({ showAll });
    const saved = p.savedSettings();
    const meshName = $('meshName').value.trim() || saved.meshName || p.device.name || '';
    $('meshName').placeholder = meshName || 'from Bluetooth name';
    const macText = $('macInput').value.trim();
    const macHint = macText ? macRevFromString(macText).slice(0, 4) : undefined;
    await p.connect({ meshName, password: $('password').value.trim() || DEFAULT_PASSWORD, macHint });
    state.projector = p;
    pill('Connected', 'on');
    $('connectView').hidden = true;
    $('controlView').hidden = false;
    $('settings').open = false;
    await run(refresh);
  } catch (e) {
    if (e.name === 'NotFoundError') { status.textContent = ''; pill('Not connected', 'idle'); return; } // picker cancelled
    status.textContent = e.message || String(e);
    status.classList.add('error');
    pill('Connection failed', 'error');
    log(`error: ${e.message}`);
    p.disconnect();
    if (/mesh name|MAC/i.test(e.message)) $('settings').open = true;
  } finally {
    $('connectBtn').disabled = false;
    $('progress').hidden = true;
  }
}

// ---------- wiring ----------
renderEffects();
$('offTimer').replaceChildren(...[0, ...Array.from({ length: 24 }, (_, i) => i + 1)].map((h) => new Option(h ? `${h} hour${h > 1 ? 's' : ''}` : 'Never', h)));
bluetoothSupport().then(renderSupport);

$('connectBtn').addEventListener('click', () => connect());
$('showAllBtn').addEventListener('click', () => connect({ showAll: true }));

$('powerBtn').addEventListener('click', () => {
  if (state.effect === 0) return playEffect(state.lastEffect || 1);
  return run(async () => { noReply(await state.projector.off()); state.effect = 0; render(); });
});

$('rotation').addEventListener('change', (e) => run(async () => {
  noReply(await state.projector.rotation(e.target.checked));
  if (state.config) state.config.motor = e.target.checked ? 255 : 0;
  state.light.motor = e.target.checked ? 255 : 0;
  render();
}));

$('brightness').addEventListener('click', (e) => {
  const v = Number(e.target.dataset.v);
  if (!v) return;
  run(async () => {
    noReply(await state.projector.brightness(v));
    if (state.config) state.config.brightness = v;
    state.light.brightness = v;
    render();
  });
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.light[chip.dataset.ch] = state.light[chip.dataset.ch] ? 0 : 255;
    render();
    sendLight();
  });
}
$('laser').addEventListener('change', (e) => { state.light.laser = e.target.checked ? 255 : 0; sendLight(); });
$('fade').addEventListener('change', (e) => { state.light.fade = e.target.checked ? 1 : 0; sendLight(); });

$('offTimer').addEventListener('change', (e) => run(async () => {
  // Re-read first: the config packet also carries the current effect, so stale values would switch it.
  const cfg = (await state.projector.queryConfig()) || state.config;
  if (!cfg) throw new Error('Could not read the projector settings.');
  cfg.offTime = Number(e.target.value);
  noReply(await state.projector.writeConfig(cfg));
  state.config = cfg;
  toast(cfg.offTime ? `Turning off after ${cfg.offTime} h` : 'Auto-off disabled');
}));

$('cycle').addEventListener('change', (e) => run(async () => {
  // Re-read first: the config packet also carries the current effect, so stale values would switch it.
  const cfg = (await state.projector.queryConfig()) || state.config;
  if (!cfg) throw new Error('Could not read the projector settings.');
  const v = Number(e.target.value);
  cfg.loopTime = v;
  cfg.isLoop = v ? 1 : 0;
  noReply(await state.projector.writeConfig(cfg));
  if (v) noReply(await state.projector.setPlaylist(EFFECTS.map((x) => x.id)));
  state.config = cfg;
  toast(v ? 'Cycling through all effects' : 'Effect cycling off');
}));

$('rawBtn').addEventListener('click', () => run(async () => {
  const text = $('rawInput').value.replace(/[^0-9a-f]/gi, '');
  if (!text || text.length % 2) throw new Error('Enter an even number of hex digits.');
  const bytes = Uint8Array.from(text.match(/../g), (x) => parseInt(x, 16));
  await state.projector.vendor(bytes);
}));

$('disconnectBtn').addEventListener('click', () => state.projector?.disconnect());
$('forgetBtn').addEventListener('click', () => {
  state.projector?.forget();
  state.projector?.disconnect();
  toast('Forgot this projector.');
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
