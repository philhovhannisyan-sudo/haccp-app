// Синхронизация с файлом в приватном репозитории GitHub.
// ---------- синхронизация с GitHub ----------
const GH_KEY = 'haccp-trace-gh';
const GH_DEFAULT = { owner: 'philhovhannisyan-sudo', repo: 'Claude-projects', branch: 'main', path: 'data/haccp.json', token: '' };
let gh = loadGh(), syncTimer = null, syncing = false, syncAgain = false, lastSync = null, editVer = 0, syncState = 'off', syncText = '';
function loadGh() { try { return { ...GH_DEFAULT, ...JSON.parse(localStorage.getItem(GH_KEY)) }; } catch { return { ...GH_DEFAULT }; } }
const ghOn = () => CAN_SYNC && !!gh.token;
const ghUrl = () => `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.path}`;
const ghHeaders = () => ({ Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github+json' });
const b64enc = s => {
  const bytes = new TextEncoder().encode(s); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
const hhmm = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const SYNC_LABEL = { off: 'Только это устройство', ok: 'Сохранено на GitHub', busy: 'Синхронизация…', pending: 'Есть неотправленные изменения', error: 'Не отправлено — нажмите, чтобы повторить' };

// state: off | ok | busy | pending | error
function status(state, text = '') {
  if (state === 'error' && syncState !== 'error') toast('Данные не отправлены на GitHub. Они сохранены на этом устройстве — нажмите на значок облака, чтобы повторить.');
  syncState = state; syncText = text;
  const b = document.getElementById('syncBadge');
  if (b) { b.className = 'sync sync-' + state; b.querySelector('span').textContent = SYNC_LABEL[state] + (state === 'ok' && lastSync ? ' ' + lastSync : ''); b.title = text || b.querySelector('span').textContent; b.setAttribute('aria-label', SYNC_LABEL[state]); }
  const st = document.getElementById('ghStatus');
  if (st) { st.textContent = text || SYNC_LABEL[state]; st.className = state === 'error' ? 'bad' : 'muted'; }
}
async function ghGet() {
  const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  const j = await r.json();
  // Файлы больше 1 МБ GitHub отдаёт без содержимого — тогда запрашиваем его отдельно, как есть
  let text;
  if (j.content) text = b64dec(j.content);
  else {
    const raw = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (!raw.ok) throw new Error(`GitHub ${raw.status}: не удалось прочитать файл данных`);
    text = await raw.text();
  }
  return { sha: j.sha, data: migrate(JSON.parse(text)) };
}
// Загрузить → объединить с локальными → при необходимости отправить. Локальные изменения не теряются.
async function sync() {
  if (!ghOn()) { status('off'); return; }
  clearTimeout(syncTimer); syncTimer = null;
  if (syncing) { syncAgain = true; return; }
  syncing = true; status('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ver = editVer;
      const { sha, data: remote } = await ghGet();
      const merged = remote ? merge(db, remote) : db;
      const changed = JSON.stringify(merged) !== JSON.stringify(db);
      db = merged; persist();
      if (changed && !app.querySelector('form[data-list] :focus')) render();
      const needPush = !remote || JSON.stringify(merged) !== JSON.stringify(remote);
      if (!needPush) { if (ver === editVer) setDirty(false); break; }
      const body = { message: 'Обновление данных HACCP', content: b64enc(JSON.stringify(merged, null, 1)), branch: gh.branch };
      if (sha) body.sha = sha;
      const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) continue; // файл успели изменить — объединяем ещё раз
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
      if (ver === editVer) setDirty(false);
      break;
    }
    lastSync = hhmm();
    status(isDirty() ? 'pending' : 'ok');
  } catch (e) {
    status('error', 'Ошибка синхронизации: ' + e.message + '. Данные сохранены на этом устройстве и будут отправлены позже.');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}
function scheduleSync() {
  editVer++;
  if (!ghOn()) { status('off'); return; }
  clearTimeout(syncTimer); status('pending');
  syncTimer = setTimeout(sync, 1500);
}
