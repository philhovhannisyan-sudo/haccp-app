// HACCP-прослеживаемость: приёмка сырья → производство → реализация.
// Данные хранятся в localStorage браузера и, если введён токен, синхронизируются
// с файлом в приватном репозитории GitHub (как в приложении учёта производства).
const KEY = 'haccp-trace-v1';
const DIRTY_KEY = KEY + '-dirty';
const SHIFTS = ['1 смена', '2 смена', '3 смена'];
const COLLS = ['suppliers', 'receipts', 'batches', 'shipments'];
const CAN_SYNC = true;

// Приводит данные любой версии к текущему формату: у записей есть upd, удаления — в deleted
const PRESSURE_FIX_BEFORE = Date.parse('2026-10-16T11:00:00Z');
const MODES_FIX_BEFORE = Date.parse('2026-10-20T06:40:00Z');
let migrated = false;
function migrate(d) {
  d = d || {};
  COLLS.forEach(c => { if (!Array.isArray(d[c])) d[c] = []; d[c].forEach(r => { if (r.upd == null) r.upd = 0; }); });
  if (!d.deleted || typeof d.deleted !== 'object') d.deleted = {};
  // Раньше решение по приёмке было галочкой «принято»; «нет» означало отказ или карантин — считаем карантином
  d.receipts.forEach(r => { if (!r.status) r.status = r.accepted ? 'Принято' : 'Карантин'; r.accepted = r.status === 'Принято'; });
  if (!d.limits || typeof d.limits !== 'object') d.limits = { upd: 0 };
  // Предел 85 был значением по умолчанию для пастеризации; для стерилизации по умолчанию 104
  if (+d.limits.pasteurTemp === 85) delete d.limits.pasteurTemp;
  // Разовое исправление: у партий, внесённых до 16.10.2026 14:00 МСК (выход этого обновления), давление не записано или ниже 1.2 —
  // фактически было 1.5 атм. Изменённая запись получает новое upd и больше не попадает под условие.
  d.batches.forEach(b => {
    if ((b.upd || 0) < PRESSURE_FIX_BEFORE && !b.voided && (b.pressure === '' || b.pressure == null || +b.pressure < 1.2)) {
      b.pressure = 1.5; b.upd = Date.now(); migrated = true;
    }
  });
  // Разовое исправление 2: у всех партий, внесённых до 20.10.2026 09:40 МСК, фактические режимы —
  // фасовка 80°C, стерилизация 104°C / 10 мин, давление 1.5 атм. Варка и Brix не меняются.
  const FIX2 = { fillTemp: 80, pasteurTemp: 104, pasteurTime: 10, pressure: 1.5 };
  d.batches.forEach(b => {
    if ((b.upd || 0) < MODES_FIX_BEFORE && !b.voided && Object.entries(FIX2).some(([k, v]) => +b[k] !== v || b[k] === '')) {
      Object.assign(b, FIX2); b.upd = Date.now(); migrated = true;
    }
  });
  return d;
}
let db = load();
function load() {
  try { return migrate(JSON.parse(localStorage.getItem(KEY))); } catch { return empty(); }
}
function empty() { return migrate({}); }
function persist() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }
function save() { persist(); setDirty(true); scheduleSync(); }
// Пометить все текущие записи удалёнными (чтобы при синхронизации они не вернулись)
function tombstones() {
  const del = { ...db.deleted }, now = Date.now();
  COLLS.forEach(c => db[c].forEach(r => { del[r.id] = now; }));
  return del;
}

// Объединение двух версий: по каждой записи побеждает более позднее изменение
function merge(a, b) {
  const out = { deleted: { ...a.deleted }, limits: (b.limits?.upd || 0) > (a.limits?.upd || 0) ? b.limits : a.limits };
  for (const [id, t] of Object.entries(b.deleted)) out.deleted[id] = Math.max(out.deleted[id] || 0, t);
  for (const c of COLLS) {
    const m = new Map();
    for (const r of [...a[c], ...b[c]]) { const cur = m.get(r.id); if (!cur || (r.upd || 0) > (cur.upd || 0)) m.set(r.id, r); }
    out[c] = [...m.values()].filter(r => !(out.deleted[r.id] >= (r.upd || 0)));
  }
  return out;
}
function isDirty() { try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch { return false; } }
function setDirty(v) { try { v ? localStorage.setItem(DIRTY_KEY, '1') : localStorage.removeItem(DIRTY_KEY); } catch {} }

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
  if (b) { b.className = 'sync sync-' + state; b.querySelector('span').textContent = SYNC_LABEL[state] + (state === 'ok' && lastSync ? ' ' + lastSync : ''); b.title = text || SYNC_LABEL[state]; b.setAttribute('aria-label', SYNC_LABEL[state]); }
  const st = document.getElementById('ghStatus');
  if (st) { st.textContent = text || SYNC_LABEL[state]; st.className = state === 'error' ? 'bad' : 'muted'; }
}
async function ghGet() {
  const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  const j = await r.json();
  return { sha: j.sha, data: migrate(JSON.parse(b64dec(j.content))) };
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
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const byId = (list, id) => db[list].find(x => x.id === id);
const today = () => new Date().toISOString().slice(0, 10);
const ymd = d => d.replaceAll('-', '').slice(2);
// Даты хранятся как ГГГГ-ММ-ДД, показываются как ДД.ММ.ГГГГ
const fmtD = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : esc(d);
const toIso = q => { const m = q.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : q; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
// Последние введённые ФИО, место хранения, линия — подставляются в новые записи
const LAST_KEY = 'haccp-trace-last';
const REMEMBER = { receipts: ['responsible', 'storage'], batches: ['operator', 'line'], shipments: ['responsible'] };
function lastVals() { try { return JSON.parse(localStorage.getItem(LAST_KEY)) || {}; } catch { return {}; } }
function rememberVals(list, o) {
  const l = lastVals();
  (REMEMBER[list] || []).forEach(k => { if (o[k]) l[list + '.' + k] = o[k]; });
  try { localStorage.setItem(LAST_KEY, JSON.stringify(l)); } catch {}
}
function shiftNow() { const h = new Date().getHours(); return SHIFTS[h >= 6 && h < 14 ? 0 : h >= 14 && h < 22 ? 1 : 2]; }
function defaults(list) {
  const d = { date: today() }, l = lastVals();
  if (list === 'receipts' || list === 'batches') d.shift = shiftNow();
  if (list === 'receipts') d.time = new Date().toTimeString().slice(0, 5);
  if (list === 'suppliers') delete d.date;
  (REMEMBER[list] || []).forEach(k => { if (l[list + '.' + k]) d[k] = l[list + '.' + k]; });
  return d;
}
// Ошибка у конкретного поля — подсказка браузера рядом с полем, а не уведомление внизу
function fieldErr(el, msg) {
  el.setCustomValidity(msg); el.reportValidity(); el.focus();
  const clear = () => el.setCustomValidity('');
  el.addEventListener('input', clear, { once: true }); el.addEventListener('change', clear, { once: true });
}
const STATUS_CLS = { 'Принято': 'ok', 'Карантин': 'warn', 'Отказ': 'bad' };
const statusBadge = r => `<span class="badge ${STATUS_CLS[r.status] || 'bad'}">${esc(r.status)}</span>`;
const icon = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const okMark = v => v ? `<span class="mark ok" role="img" aria-label="Да" title="Да">${icon('check')}</span>` : `<span class="mark bad" role="img" aria-label="Нет" title="Нет">${icon('x')}</span>`;
// Входной контроль одной ячейкой: «3/3» или «2/3 · документы»
function checks(r) {
  const items = [['органолептика', r.organoleptic], ['документы', r.docsOk], ['примеси', r.pestOk]];
  const failed = items.filter(([, v]) => !v).map(([n]) => n);
  return `<span class="badge ${failed.length ? 'bad' : 'ok'}">${items.length - failed.length}/${items.length}${failed.length ? ' · ' + failed.join(', ') : ''}</span>`;
}

// ---------- уведомления и подтверждения (вместо alert/confirm) ----------
function toast(msg, kind = 'error') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.setAttribute('role', kind === 'ok' ? 'status' : 'alert'); t.innerHTML = `${icon(kind === 'ok' ? 'check' : 'x')}<span>${esc(msg)}</span>`;
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 4000);
}
function ask(msg, okLabel = 'Да', danger = false) {
  const d = document.createElement('dialog');
  d.className = 'ask'; d.setAttribute('aria-labelledby', 'askMsg');
  d.innerHTML = `<form method="dialog"><p id="askMsg">${esc(msg)}</p><div class="row"><button value="" class="btn">Отмена</button>
    <button value="ok" class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(okLabel)}</button></div></form>`;
  document.body.append(d); d.showModal();
  return new Promise(res => d.addEventListener('close', () => { res(d.returnValue === 'ok'); d.remove(); }));
}

// ---------- критические пределы ККТ ----------
// Значение ниже предела подсвечивается. Четвёртый элемент true — ККТ: отклонение по ней
// попадает в «Отклонения ККТ» и требует корректирующего действия; КТ (варка, Brix) только подсвечиваются
const LIMITS = [
  ['cookTemp', 'T° варки, °C', 100], ['brix', 'Brix готового, %', 60], ['fillTemp', 'T° фасовки, °C', 80],
  // Поле называется pasteurTemp по старой памяти, теперь это T° стерилизации
  ['pasteurTemp', 'T° стерилизации, °C', 104, true], ['pasteurTime', 'Время стерилизации, мин', 10, true],
  ['pressure', 'Атмосферное давление, атм', 1.2, true],
];
const lim = k => { const v = db.limits?.[k]; return v === '' || v == null ? LIMITS.find(l => l[0] === k)[2] : +v; };
const isOut = (b, k) => b[k] !== '' && b[k] != null && +b[k] < lim(k);
function deviations(b) {
  const out = LIMITS.filter(([k, , , ccp]) => ccp && isOut(b, k)).map(([k, l]) => `${l}: ${b[k]} < ${lim(k)}`);
  return out;
}
const limCell = (b, k, text) => isOut(b, k) ? `<span class="bad" title="Ниже предела ${lim(k)}">${text}</span>` : text;

// ---------- расчёт остатков ----------
// Аннулированные записи остаются в журнале, но не участвуют в остатках и сводке
const live = r => !r.voided;
const usedOfReceipt = id => db.batches.filter(live).reduce((s, b) => s + b.ingredients.filter(i => i.receiptId === id).reduce((a, i) => a + +i.qty, 0), 0);
const restOfReceipt = r => +r.qty - usedOfReceipt(r.id);
const shippedOfBatch = id => db.shipments.filter(s => live(s) && s.batchId === id).reduce((a, s) => a + +s.qty, 0);
const restOfBatch = b => +b.jars - shippedOfBatch(b.id);

function nextCode(prefix, date, list) {
  const base = `${prefix}-${ymd(date)}`;
  const n = Math.max(0, ...db[list].filter(x => x.code.startsWith(base + '-')).map(x => +x.code.slice(base.length + 1))) + 1;
  return `${base}-${String(n).padStart(2, '0')}`;
}

// ---------- описания форм ----------
const FORMS = {
  suppliers: [
    ['name', 'Наименование', 'text', true], ['inn', 'ИНН', 'text'], ['address', 'Адрес', 'text'],
    ['phone', 'Контакт', 'text'], ['certificate', 'Сертификаты / декларации', 'text'],
    ['approved', 'Одобрен (аудит пройден)', 'checkbox'],
  ],
  // ['§', 'Заголовок'] — начало раздела формы; пятый элемент — подсказка в пустом поле
  receipts: [
    ['§', 'Поставка'],
    ['date', 'Дата приёмки', 'date', true], ['time', 'Время', 'time'], ['shift', 'Смена', SHIFTS, true],
    ['supplierId', 'Поставщик', v => db.suppliers.filter(s => live(s) || s.id === v).map(s => [s.id, s.name + (s.approved ? '' : ' (не одобрен)')]), true],
    ['material', 'Сырьё', 'text', true, 'клубника, сахар, пектин…'], ['qty', 'Количество', 'number', true],
    ['unit', 'Ед.', ['кг', 'л', 'шт'], true], ['supplierLot', 'Партия поставщика', 'text'],
    ['invoice', '№ накладной / ТТН', 'text'], ['harvestDate', 'Дата сбора / изготовления', 'date'], ['expiry', 'Годен до', 'date'],
    ['§', 'Входной контроль'],
    ['transportTemp', 'T° в транспорте, °C', 'number'], ['productTemp', 'T° продукта, °C', 'number'], ['brix', 'Brix сырья, %', 'number'],
    ['organoleptic', 'Органолептика в норме', 'checkbox'], ['docsOk', 'Документы в порядке', 'checkbox'],
    ['pestOk', 'Нет вредителей / посторонних примесей', 'checkbox'],
    ['§', 'Решение'],
    ['status', 'Решение по приёмке', ['Принято', 'Карантин', 'Отказ'], true],
    ['storage', 'Место хранения', 'text', false, 'Камера №1'], ['responsible', 'Принял (ФИО)', 'text', true], ['note', 'Примечание', 'text'],
  ],
  batches: [
    ['§', 'Партия'],
    ['date', 'Дата производства', 'date', true], ['shift', 'Смена', SHIFTS, true],
    ['product', 'Продукт', 'text', true, 'Варенье клубничное'], ['line', 'Линия / котёл', 'text'], ['operator', 'Технолог / мастер смены', 'text', true],
    ['§', 'Варка, КТ и ККТ'],
    ['cookTemp', 'КТ: T° варки, °C', 'number'], ['cookTime', 'Время варки, мин', 'number'],
    ['brix', 'КТ: Brix готового, %', 'number'], ['fillTemp', 'T° фасовки, °C', 'number'],
    ['pasteurTemp', 'ККТ: T° стерилизации, °C', 'number', true], ['pasteurTime', 'Время стерилизации, мин', 'number'],
    ['pressure', 'ККТ: атмосферное давление, атм', 'number', true],
    ['capOk', 'КТ: Герметичность укупорки', 'checkbox'],
    ['corrective', 'Корректирующее действие (при отклонении ККТ)', 'text'],
    ['§', 'Выпуск'],
    ['jars', 'Выпущено банок, шт', 'number', true], ['jarSize', 'Фасовка (г)', 'number'],
    ['bestBefore', 'Годен до', 'date', true], ['released', 'Выпуск одобрен ОТК', 'checkbox'], ['note', 'Примечание', 'text'],
  ],
  shipments: [
    ['date', 'Дата отгрузки', 'date', true],
    ['batchId', 'Партия ГП', v => db.batches.filter(b => (live(b) && restOfBatch(b) > 0) || b.id === v).map(b => [b.id, `${b.code} · ${b.product} (ост. ${restOfBatch(b)})`]), true],
    ['customer', 'Покупатель / магазин', 'text', true], ['qty', 'Банок, шт', 'number', true],
    ['invoice', '№ накладной', 'text'], ['vehicle', 'Транспорт', 'text'], ['responsible', 'Отгрузил', 'text'],
  ],
};

// Температуры могут быть отрицательными (замороженное сырьё), остальные числа — нет
const SIGNED = ['transportTemp', 'productTemp', 'cookTemp', 'fillTemp', 'pasteurTemp'];
// Текстовые поля с подсказками из уже введённых значений
const SUGGEST = ['product', 'material', 'customer', 'storage', 'line', 'vehicle', 'responsible', 'operator'];
function field([name, label, type, req, ph], val, list) {
  if (name === '§') return `<h3 class="fs">${label}</h3>`;
  const r = req ? 'required' : '';
  if (req && type !== 'checkbox') label += ' <span class="req" aria-hidden="true">*</span>';
  if (list === 'batches' && LIMITS.some(l => l[0] === name)) label += ` <span class="lim">≥ ${lim(name)}</span>`;
  if (type !== 'checkbox') label = `<span class="lt">${label}</span>`;
  if (type === 'text' && SUGGEST.includes(name)) {
    const vals = [...new Set(db[list].filter(live).map(x => x[name]).filter(Boolean))];
    if (vals.length) return `<label>${label}<input type="text" name="${name}" value="${esc(val)}" list="dl-${name}" autocomplete="off" ${ph ? `placeholder="${esc(ph)}"` : ''} ${r}>
      <datalist id="dl-${name}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist></label>`;
  }
  if (type === 'checkbox') return `<label><span><input type="checkbox" name="${name}" ${val ? 'checked' : ''}> ${label}</span></label>`;
  let opts = Array.isArray(type) ? type.map(o => [o, o]) : typeof type === 'function' ? type(val) : null;
  if (opts) return `<label>${label}<select name="${name}" ${r}><option value=""></option>${opts.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  return `<label>${label}<input type="${type}" name="${name}" value="${esc(val)}" ${ph ? `placeholder="${esc(ph)}"` : ''} ${type === 'number' ? `step="any"${SIGNED.includes(name) ? '' : ' min="0"'}` : ''} ${r}></label>`;
}
function readForm(form, fields) {
  const o = {};
  for (const [name, , type] of fields) {
    if (name === '§') continue;
    const el = form.elements[name];
    o[name] = type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

// ---------- рендер ----------
let tab = 'overview', editing = null, formOpen = false, filterText = '', flag = null, formDirty = false;
let period = { from: '', to: '' };
const sortState = {};
const app = document.getElementById('app');
// Готовые фильтры, на которые ведут карточки сводки
const FLAGS = {
  instock: { tab: 'receipts', label: 'На складе', fn: r => live(r) && r.accepted && restOfReceipt(r) > 0 },
  quarantine: { tab: 'receipts', label: 'Карантин', fn: r => live(r) && r.status === 'Карантин' },
  rejected: { tab: 'receipts', label: 'Отказ / карантин', fn: r => live(r) && !r.accepted },
  stock: { tab: 'batches', label: 'Есть на складе ГП', fn: b => live(b) && restOfBatch(b) > 0 },
  unreleased: { tab: 'batches', label: 'Ждут одобрения ОТК', fn: b => live(b) && !b.released },
  ccp: { tab: 'batches', label: 'Отклонения ККТ', fn: b => live(b) && deviations(b).length > 0 },
  voided: { tab: null, label: 'Аннулированные', fn: r => r.voided },
  expiring: { tab: 'receipts', label: 'Срок годности ≤ 7 дней', fn: r => FLAGS.instock.fn(r) && !!r.expiry && r.expiry <= addDays(today(), 7) },
  unapproved: { tab: 'suppliers', label: 'Не одобрены', fn: s => live(s) && !s.approved },
};
const TABS = ['overview', 'trace', 'suppliers', 'receipts', 'batches', 'shipments', 'settings'];
function hashFor() { return '#' + tab + (tab === 'trace' && traceQuery ? '/' + encodeURIComponent(traceQuery) : flag ? '/' + flag : ''); }
function pushHash() { if (location.hash !== hashFor()) history.pushState(null, '', hashFor()); }
function fromHash() {
  const [t, arg = ''] = location.hash.slice(1).split('/');
  const a = decodeURIComponent(arg);
  setTab(TABS.includes(t) ? t : 'overview', FLAGS[a] ? a : null);
  if (tab === 'trace') traceQuery = a;
}
function setTab(t, f = null) {
  tab = t; editing = null; formOpen = false; formDirty = false; filterText = ''; flag = f; period = { from: '', to: '' };
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === t);
    if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelector('#tabs [data-more-tabs]').classList.toggle('active', MORE_TABS.some(([k]) => k === t));
}
// Незаполненная до конца форма не закрывается молча
async function canLeave() {
  if (!formDirty || !(formOpen || editing)) return true;
  if (!await ask('Закрыть форму? Введённые данные не сохранятся.', 'Закрыть', true)) return false;
  formDirty = false; return true;
}
addEventListener('beforeunload', e => { if (formDirty && (formOpen || editing)) e.preventDefault(); });
// На телефоне в нижней панели 5 вкладок, остальные — в «Ещё»
const MORE_TABS = [['suppliers', 'Поставщики', 'users'], ['settings', 'Данные', 'db']];
function go(t, f = null) { setTab(t, f); render(); pushHash(); focusTitle(); }
const focusTitle = () => app.querySelector('h1')?.focus({ preventScroll: true });
addEventListener('popstate', () => { fromHash(); render(); scrollTo(0, 0); });
document.getElementById('tabs').onclick = async e => {
  const btn = e.target.closest('button');
  if (btn?.hasAttribute('data-more-tabs')) return menu(btn, MORE_TABS.map(([k, label, ic]) => ({ label, icon: ic, run: async () => { if (await canLeave()) { go(k); scrollTo(0, 0); } } })));
  if (btn?.dataset.tab && await canLeave()) { go(btn.dataset.tab); scrollTo(0, 0); }
};
document.getElementById('syncBadge').onclick = () => ghOn() ? sync() : go('settings');

// Перерисовка не должна сбрасывать фокус клавиатуры: возвращаем его на тот же элемент
const FOCUS_ATTRS = ['id', 'data-edit', 'data-void', 'data-more', 'data-sort', 'data-flag', 'data-go', 'data-today', 'data-trace', 'data-add', 'data-showvoid', 'data-unflag'];
function focusSel(el) {
  if (!el || !app.contains(el)) return null;
  for (const a of FOCUS_ATTRS) if (el.hasAttribute(a) && (a !== 'id' || el.id)) return a === 'id' ? '#' + CSS.escape(el.id) : `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  return 'h1';
}
function render() {
  closeMenu();
  const sel = focusSel(document.activeElement);
  app.innerHTML = { overview: viewOverview, trace: viewTrace, suppliers: viewSuppliers, receipts: viewReceipts, batches: viewBatches, shipments: viewShipments, settings: viewSettings }[tab]();
  app.querySelector('h1')?.setAttribute('tabindex', '-1');
  bind();
  // Если кнопки больше нет (запись аннулирована), фокус — на «⋯» той же строки
  const alt = sel?.replace(/^\[data-(edit|void)=/, '[data-more=');
  if (sel && !app.contains(document.activeElement)) (app.querySelector(sel) || app.querySelector(alt) || app.querySelector('h1'))?.focus({ preventScroll: true });
}

function crudForm(list, title, extra = '') {
  const rec = editing ? byId(list, editing) : null;
  return `<div class="card" id="formCard"><h2>${rec ? 'Редактирование ' + esc(rec.code || rec.name) : title}</h2>
    <form class="grid" data-list="${list}">${FORMS[list].map(f => field(f, (rec || defaults(list))[f[0]], list)).join('')}${extra}
    <div class="row"><button class="btn primary">${rec ? 'Сохранить' : 'Добавить'}</button>
    <button type="button" class="btn" data-cancel>Отмена</button></div></form></div>`;
}
// Журнал: список сначала, форма — по кнопке «Добавить» или «Изменить»
// keys — номера колонок, которые видны в свёрнутой карточке на телефоне
function journal(list, { title, formTitle, head, row, keys = [], extra = '', reverse = true }) {
  const f = flag && (FLAGS[flag].tab === list || FLAGS[flag].tab === null) ? FLAGS[flag] : null;
  const nVoided = db[list].filter(r => r.voided).length;
  const dated = list !== 'suppliers';
  const inPeriod = r => !dated || ((!period.from || r.date >= period.from) && (!period.to || r.date <= period.to));
  const items = (reverse ? [...db[list]].reverse() : db[list]).filter(f ? f.fn : () => true).filter(inPeriod);
  const open = formOpen || editing;
  const per = period.from || period.to ? `за период ${period.from ? 'с ' + fmtD(period.from) : ''} ${period.to ? 'по ' + fmtD(period.to) : ''}` : 'за всё время';
  return `<div class="head"><h1 class="page">${title}</h1>${open ? '' : '<button class="btn primary noprint" data-add>+ Добавить</button>'}</div>
    ${open ? crudForm(list, formTitle, extra) : ''}
    <p class="print-only">Журнал «${title}» ${dated ? per : ''}${f ? ' · ' + esc(f.label) : ''} · распечатано ${fmtTs(Date.now())}</p>
    ${db[list].length ? `<div class="toolbar noprint"><input type="search" id="filter" value="${esc(filterText)}" placeholder="Поиск: код, дата, название, статус…" aria-label="Поиск по журналу">
      ${dated ? `<div class="period"><label>с<input type="date" id="pFrom" value="${period.from}"></label><label>по<input type="date" id="pTo" value="${period.to}"></label>
        ${period.from || period.to ? `<button class="btn icon" id="pClear" aria-label="Сбросить период" title="Сбросить период">${icon('x')}</button>` : ''}</div>` : ''}
      ${f ? `<button class="chip" data-unflag>${esc(f.label)} ${icon('x')}</button>` : nVoided ? `<button class="chip quiet" data-showvoid>${icon('ban')} Аннулированные: ${nVoided}</button>` : ''}
      ${items.length > 1 ? `<select id="sortSel" class="phone-only" aria-label="Сортировка"><option value="">Сортировка: по умолчанию</option>${head.flatMap((h, i) => [[i, 1, '↑'], [i, -1, '↓']].map(([k, d, ar]) => `<option value="${k}:${d}" ${sortState[list]?.i === k && sortState[list]?.dir === d ? 'selected' : ''}>${h} ${ar}</option>`)).join('')}</select>` : ''}
      <span class="tools"><button class="btn" id="csv" title="Скачать таблицу для Excel">${icon('table')} Excel</button><button class="btn" onclick="print()">${icon('print')} Печать</button></span></div>` : ''}
    ${items.length ? `<div class="card tbl jr"><table data-keys="${keys.join(',')}"><thead><tr>${head.map((h, i) => `<th scope="col"><button type="button" class="sort" data-sort="${i}">${h}</button></th>`).join('')}<th scope="col"></th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>` : ''}
    <p class="empty" id="noMatch" ${items.length || (open && !db[list].length) ? 'hidden' : ''}>${db[list].length ? 'Нет записей по этому фильтру.' : 'Записей пока нет — нажмите «+ Добавить», чтобы внести первую.'}</p>`;
}
// На виду — «Изменить» и «Аннулировать»; удаление и восстановление — в меню «⋯»
const actions = (list, r) => `<td class="noprint">${live(r) ? `<button class="btn icon" data-edit="${list}:${r.id}" aria-label="Изменить" title="Изменить">${icon('edit')}</button>
  <button class="btn void-btn" data-void="${list}:${r.id}" aria-label="Аннулировать" title="Аннулировать с указанием причины">${icon('ban')}<span>Аннулировать</span></button>` : ''}
  <button class="btn icon" data-more="${list}:${r.id}" aria-label="Ещё действия" title="Ещё" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
  <button type="button" class="btn expand" data-expand aria-expanded="false">Подробнее</button></td>`;
const tr = r => `<tr${r.voided ? ' class="voided"' : ''}>`;
const fmtTs = t => t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const voidBadge = r => r.voided ? ` <span class="badge void" title="${esc(r.voidReason)}">Аннулировано</span>` : '';
const voidNote = r => r.voided ? `<div class="void-note"><span class="badge void">Аннулировано</span> ${esc(r.voidReason)}<span class="muted"> — ${esc(r.voidBy)}, ${fmtTs(r.voidAt)}</span></div>` : '';

function viewSuppliers() {
  return journal('suppliers', { title: 'Поставщики', formTitle: 'Новый поставщик', reverse: false,
    head: ['Наименование', 'ИНН', 'Адрес', 'Контакт', 'Сертификаты', 'Одобрен', 'Поставок'], keys: [5, 6],
    row: s => `${tr(s)}<td>${esc(s.name)}${voidNote(s)}</td><td>${esc(s.inn)}</td><td>${esc(s.address)}</td><td>${esc(s.phone)}</td>
    <td>${esc(s.certificate)}</td><td>${okMark(s.approved)}</td><td>${db.receipts.filter(r => live(r) && r.supplierId === s.id).length}</td>${actions('suppliers', s)}</tr>` });
}

function viewReceipts() {
  return journal('receipts', { title: 'Приёмка сырья', formTitle: 'Приёмка сырья (журнал входного контроля)',
    head: ['Лот', 'Дата / смена', 'Поставщик', 'Сырьё', 'Кол-во', 'Остаток', 'T°', 'Brix', 'Контроль', 'Статус', 'Принял'], keys: [1, 3, 5, 9],
    row: r => `${tr(r)}<td><a href="#" data-trace="${r.code}">${r.code}</a>${voidNote(r)}</td><td>${fmtD(r.date)} ${esc(r.time)}<br><span class="muted">${r.shift}</span></td>
    <td>${esc(byId('suppliers', r.supplierId)?.name)}</td><td>${esc(r.material)}<br><span class="muted">${esc(r.supplierLot)}</span></td>
    <td>${r.qty} ${r.unit}</td><td>${restOfReceipt(r)} ${r.unit}</td><td>${esc(r.productTemp)}</td><td>${esc(r.brix)}</td>
    <td>${checks(r)}</td>
    <td>${statusBadge(r)}</td><td>${esc(r.responsible)}</td>${actions('receipts', r)}</tr>` });
}

function ingredientRows(ings) {
  // Лоты без остатка не предлагаем — кроме уже выбранных в этой партии
  const mine = id => ings?.some(i => i.receiptId === id);
  const lots = db.receipts.filter(r => r.accepted && ((live(r) && restOfReceipt(r) > 0) || mine(r.id)));
  const row = (i = {}) => `<div class="ing"><select name="ingLot" aria-label="Лот сырья"><option value=""></option>${lots.map(r =>
    `<option value="${r.id}" data-unit="${r.unit}" ${r.id === i.receiptId ? 'selected' : ''}>${r.code} · ${esc(r.material)} · ост. ${restOfReceipt(r)} ${r.unit}</option>`).join('')}</select>
    <span class="ing-q"><input name="ingQty" type="number" step="any" min="0" placeholder="кол-во" aria-label="Количество" value="${esc(i.qty)}"><span class="ing-unit">${byId('receipts', i.receiptId)?.unit || ''}</span></span>
    <button type="button" class="btn icon" data-rming aria-label="Убрать строку" title="Убрать строку">${icon('x')}</button></div>`;
  return `<div style="grid-column:1/-1"><h3 class="fs">Сырьё</h3><label><span class="lt">Использованное сырьё (лоты приёмки) <span class="req" aria-hidden="true">*</span></span></label>
    ${lots.length ? '' : '<p class="muted">Нет принятых лотов с остатком — сначала оформите приёмку сырья.</p>'}
    <div id="ings">${(ings?.length ? ings : [{}]).map(row).join('')}</div>
    <button type="button" class="btn" id="addIng">+ сырьё</button><template id="ingTpl">${row()}</template></div>`;
}

function viewBatches() {
  const rec = editing ? byId('batches', editing) : null;
  return journal('batches', { title: 'Производство', formTitle: 'Производственная партия (варка)', extra: ingredientRows(rec?.ingredients),
    head: ['Код партии', 'Дата / смена', 'Продукт', 'Сырьё', 'Варка', 'Brix', 'Стерил.', 'Давл.', 'Банок', 'Остаток', 'Годен до', 'ОТК'], keys: [1, 2, 9, 11],
    row: b => `${tr(b)}<td><a href="#" data-trace="${b.code}">${b.code}</a>${deviations(b).length ? `<br><span class="badge bad" title="${esc(deviations(b).join('; '))}">Отклонение ККТ</span>` : ''}${voidNote(b)}</td><td>${fmtD(b.date)}<br><span class="muted">${b.shift}</span></td>
    <td>${esc(b.product)}</td><td>${b.ingredients.map(i => { const r = byId('receipts', i.receiptId); return `${r?.code} ${esc(r?.material)}: ${i.qty} ${r?.unit || ''}`; }).join('<br>')}</td>
    <td>${limCell(b, 'cookTemp', esc(b.cookTemp) + '°')} / ${esc(b.cookTime)}м</td><td>${limCell(b, 'brix', esc(b.brix))}</td><td>${limCell(b, 'pasteurTemp', esc(b.pasteurTemp) + '°')} / ${limCell(b, 'pasteurTime', esc(b.pasteurTime) + 'м')}</td><td>${limCell(b, 'pressure', esc(b.pressure))}</td>
    <td>${b.jars}</td><td>${restOfBatch(b)}</td><td>${fmtD(b.bestBefore)}</td><td>${okMark(b.released)}</td>${actions('batches', b)}</tr>` });
}

function viewShipments() {
  return journal('shipments', { title: 'Реализация', formTitle: 'Отгрузка / реализация',
    head: ['Дата', 'Партия', 'Продукт', 'Покупатель', 'Банок', 'Накладная', 'Транспорт'], keys: [1, 3, 4],
    row: s => { const b = byId('batches', s.batchId); return `${tr(s)}<td>${fmtD(s.date)}${voidNote(s)}</td>
    <td><a href="#" data-trace="${b?.code}">${b?.code}</a></td><td>${esc(b?.product)}</td><td>${esc(s.customer)}</td><td>${s.qty}</td>
    <td>${esc(s.invoice)}</td><td>${esc(s.vehicle)}</td>${actions('shipments', s)}</tr>`; } });
}

// ---------- сводка ----------
function viewOverview() {
  const inStock = db.receipts.filter(FLAGS.instock.fn);
  const rejected = db.receipts.filter(FLAGS.rejected.fn);
  const ccpFail = db.batches.filter(FLAGS.ccp.fn);
  const unreleased = db.batches.filter(FLAGS.unreleased.fn);
  const jars = db.batches.filter(live).reduce((a, b) => a + restOfBatch(b), 0);
  const kpi = (n, label, to, alert) => `<button class="kpi ${alert && n ? 'alert' : ''}" ${FLAGS[to] ? `data-flag="${to}"` : `data-go="${to}"`}><b>${n}</b><span>${label}</span></button>`;
  const none = text => `<p class="empty">${text}</p>`;
  if (!COLLS.some(c => db[c].length)) return `<h1 class="page">Сводка</h1><div class="card empty-start"><h2>Данных пока нет</h2>
    <p class="muted">Начните с вкладки «Поставщики», затем вносите приёмку сырья, партии и отгрузки. Чтобы посмотреть, как всё работает, загрузите демо-данные.</p>
    <div class="row"><button class="btn primary" data-go="suppliers" data-open>${icon('users')} Добавить поставщика</button><button class="btn" data-go="settings">Демо-данные и импорт</button></div></div>`;
  const recent = (list, n = 6) => db[list].filter(live).sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  const t = today(), expired = db.receipts.filter(r => FLAGS.expiring.fn(r) && r.expiry < t).length;
  const todo = [
    ['expiring', db.receipts.filter(FLAGS.expiring.fn).length, n => `Сырьё с истекающим сроком годности: ${n}${expired ? ` (уже истёк: ${expired})` : ''}`],
    ['quarantine', db.receipts.filter(FLAGS.quarantine.fn).length, n => `Лотов в карантине: ${n}`],
    ['unreleased', unreleased.length, n => `Партий ждут одобрения ОТК: ${n}`],
    ['ccp', ccpFail.length, n => `Партий с отклонением ККТ: ${n}`],
    ['unapproved', db.suppliers.filter(FLAGS.unapproved.fn).length, n => `Поставщиков без одобрения: ${n}`],
  ].filter(([, n]) => n);
  const cnt = list => db[list].filter(r => live(r) && r.date === t).length;
  const todayBtn = (list, label) => `<button class="link" data-today="${list}">${label}: <b>${cnt(list)}</b></button>`;
  return `<h1 class="page">Сводка</h1>
    <div class="cols top"><div class="card attn"><h2>${icon('alert')} Требует внимания</h2>${todo.length ? `<ul>${todo.map(([k, n, text]) => `<li><button class="link" data-flag="${k}">${text(n)}</button></li>`).join('')}</ul>` : `<p class="ok">${icon('check')} Всё в порядке</p>`}</div>
    <div class="card"><h2>Сегодня, ${fmtD(t)}</h2><p class="today">${todayBtn('receipts', 'Приёмок')} ${todayBtn('batches', 'Партий')} ${todayBtn('shipments', 'Отгрузок')}</p></div></div>
    <div class="kpis">
    ${kpi(inStock.length, 'Лотов сырья на складе', 'instock')}${kpi(db.batches.filter(live).length, 'Партий выпущено', 'batches')}
    ${kpi(jars, 'Банок на складе ГП', 'stock')}${kpi(unreleased.length, 'Ждут одобрения ОТК', 'unreleased', true)}
    ${kpi(ccpFail.length, 'Отклонения ККТ', 'ccp', true)}${kpi(rejected.length, 'Отказ / карантин при приёмке', 'rejected', true)}</div>
    <div class="cols">
    <div class="card tbl"><h2>Последние партии</h2>${db.batches.length ? '' : none('Партий пока нет')}<table>
      <thead><tr><th scope="col">Код</th><th scope="col">Дата</th><th scope="col">Продукт</th><th scope="col">Банок</th><th scope="col">ОТК</th></tr></thead><tbody>
      ${recent('batches').map(b => `<tr><td><a href="#" data-trace="${b.code}">${b.code}</a></td><td class="num">${fmtD(b.date)}</td><td>${esc(b.product)}</td>
      <td class="num">${restOfBatch(b)} / ${b.jars}</td><td>${b.released ? '<span class="badge ok">Выпущено</span>' : '<span class="badge warn">Ожидает</span>'}</td></tr>`).join('')}</tbody></table></div>
    <div class="card tbl"><h2>Последние поставки сырья</h2>${db.receipts.length ? '' : none('Поставок пока нет')}<table>
      <thead><tr><th scope="col">Лот</th><th scope="col">Дата</th><th scope="col">Сырьё</th><th scope="col">Остаток</th><th scope="col">Статус</th></tr></thead><tbody>
      ${recent('receipts').map(r => `<tr><td><a href="#" data-trace="${r.code}">${r.code}</a></td><td class="num">${fmtD(r.date)}</td><td>${esc(r.material)}</td>
      <td class="num">${restOfReceipt(r)} ${r.unit}</td><td>${statusBadge(r)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}

// ---------- прослеживание ----------
let traceQuery = '';
function viewTrace() {
  return `<h1 class="page">Поиск и прослеживание</h1><div class="card noprint">
    <form class="row" id="traceForm"><label style="flex:1;min-width:220px">Код партии с банки (P-…), лот сырья (R-…), дата производства или название продукта
    <input type="search" name="q" value="${esc(traceQuery)}" placeholder="например P-261002-01 или 02.10.2026" list="codes" autocomplete="off"></label>
    <datalist id="codes">${[...db.batches, ...db.receipts].map(x => `<option value="${x.code}">`).join('')}</datalist>
    <button class="btn primary">Найти</button><button type="button" class="btn" id="scan" hidden>${icon('camera')} Сканировать</button>
    ${traceQuery ? `<button type="button" class="btn" onclick="print()">${icon('print')} Печать</button>` : ''}</form>
    <p class="muted">Назад: банка → партия → смена, ККТ → лоты сырья → поставщики, приёмка. Вперёд: лот сырья → партии → покупатели (для отзыва продукции).</p></div>
    ${traceQuery ? `<p class="print-only">Отчёт о прослеживании по запросу «${esc(traceQuery)}» · сформирован ${fmtTs(Date.now())}</p>` + traceResult(traceQuery.trim()) : ''}`;
}

function traceResult(q) {
  const ql = q.toLowerCase(), iso = toIso(q);
  // Код можно ввести не полностью: «260929» найдёт P-260929-01
  const batches = db.batches.filter(b => b.code.toLowerCase().includes(ql) || b.date === iso || b.product.toLowerCase().includes(ql));
  const receipts = db.receipts.filter(r => r.code.toLowerCase().includes(ql) || r.date === iso);
  if (!batches.length && !receipts.length) return `<div class="card">Ничего не найдено по «${esc(q)}».</div>`;
  return receipts.map(forwardTrace).join('') + batches.map(backTrace).join('');
}

function receiptBlock(r, used) {
  const s = byId('suppliers', r.supplierId) || {};
  return `<div class="chain raw"><h3>Лот сырья ${r.code} — ${esc(r.material)}${used != null ? `, использовано ${used} ${r.unit}` : ''}${voidBadge(r)}</h3>${voidNote(r)}
    <div>Поступило: <b>${fmtD(r.date)} ${esc(r.time)}</b>, <span class="pill">${r.shift}</span>, принял: <b>${esc(r.responsible)}</b>, место хранения: ${esc(r.storage) || '—'}</div>
    <div>Объём партии: <b>${r.qty} ${r.unit}</b> (остаток ${restOfReceipt(r)} ${r.unit}); накладная ${esc(r.invoice) || '—'}; партия поставщика ${esc(r.supplierLot) || '—'}</div>
    <div>Поставщик: <b>${esc(s.name)}</b>, ИНН ${esc(s.inn) || '—'}, ${esc(s.address)}; сертификаты: ${esc(s.certificate) || '—'}; одобрен ${okMark(s.approved)}</div>
    <div>Входной контроль: T° трансп. ${esc(r.transportTemp) || '—'}°C, T° прод. ${esc(r.productTemp) || '—'}°C, Brix ${esc(r.brix) || '—'};
      органолептика ${okMark(r.organoleptic)}, документы ${okMark(r.docsOk)}, примеси/вредители ${okMark(r.pestOk)};
      дата сбора ${fmtD(r.harvestDate) || '—'}, годен до ${fmtD(r.expiry) || '—'}; решение: ${statusBadge(r)}</div>
    ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</div>`;
}

function shipmentsTable(b) {
  const sh = db.shipments.filter(s => s.batchId === b.id);
  return `<div class="chain ship"><h3>Реализация (отгружено ${shippedOfBatch(b.id)} из ${b.jars}, на складе ${restOfBatch(b)})</h3>
    ${sh.length ? `<div class="tbl"><table><thead><tr><th scope="col">Дата</th><th scope="col">Покупатель</th><th scope="col">Банок</th><th scope="col">Накладная</th><th scope="col">Транспорт</th></tr></thead><tbody>
    ${sh.map(s => `${tr(s)}<td>${fmtD(s.date)}${voidBadge(s)}</td><td>${esc(s.customer)}</td><td>${s.qty}</td><td>${esc(s.invoice)}</td><td>${esc(s.vehicle)}</td></tr>`).join('')}</tbody></table></div>` : '<span class="muted">Отгрузок нет</span>'}</div>`;
}

// Схема цепочки: поставщики → лоты → партии → покупатели
const flowStep = (n, label, cur) => `<div class="step${cur ? ' cur' : ''}"><b>${n}</b><span>${label}</span></div>`;
const flow = steps => `<div class="flow" aria-label="Цепочка прослеживания">${steps.join('<span class="arr" aria-hidden="true">→</span>')}</div>`;
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
function customersOf(bs) {
  const m = new Map();
  db.shipments.filter(s => live(s) && bs.some(b => b.id === s.batchId)).forEach(s => {
    const c = m.get(s.customer) || { qty: 0, docs: [] };
    c.qty += +s.qty; if (s.invoice) c.docs.push(s.invoice); m.set(s.customer, c);
  });
  return m;
}
function backTrace(b) {
  const lots = b.ingredients.map(i => byId('receipts', i.receiptId)).filter(Boolean);
  const sups = new Set(lots.map(r => r.supplierId)), cust = customersOf([b]);
  return `<div class="card"><h2>Партия готовой продукции ${b.code} — ${esc(b.product)}${voidBadge(b)}</h2>${voidNote(b)}
    ${flow([flowStep(sups.size, plural(sups.size, 'поставщик', 'поставщика', 'поставщиков')), flowStep(lots.length, plural(lots.length, 'лот сырья', 'лота сырья', 'лотов сырья')),
      flowStep(b.code, 'партия', true), flowStep(cust.size, plural(cust.size, 'покупатель', 'покупателя', 'покупателей'))])}
    <div class="recall">Выпущено <b>${b.jars}</b> банок: отгружено <b>${shippedOfBatch(b.id)}</b>${cust.size ? ` — ${[...cust].map(([c, x]) => `${esc(c)} (${x.qty})`).join(', ')}` : ''}; на складе <b>${restOfBatch(b)}</b>.</div>
    <div class="chain"><h3>Производство</h3>
    <div>Дата: <b>${fmtD(b.date)}</b>, <span class="pill">${b.shift}</span>, линия: ${esc(b.line) || '—'}, ответственный: <b>${esc(b.operator)}</b></div>
    <div>КТ: варка ${esc(b.cookTemp) || '—'}°C / ${esc(b.cookTime) || '—'} мин; Brix ${esc(b.brix) || '—'}%; фасовка ${esc(b.fillTemp) || '—'}°C; герметичность укупорки ${okMark(b.capOk)}</div>
    <div>ККТ: стерилизация ${esc(b.pasteurTemp) || '—'}°C / ${esc(b.pasteurTime) || '—'} мин; атмосферное давление ${esc(b.pressure) || '—'} атм</div>
    <div>Выпуск: ${b.jars} банок × ${esc(b.jarSize) || '—'} г, годен до ${fmtD(b.bestBefore)}, ОТК ${okMark(b.released)}</div>
    ${deviations(b).length ? `<div><span class="badge bad">Отклонение ККТ</span> ${esc(deviations(b).join('; '))}. Корректирующее действие: <b>${esc(b.corrective) || '—'}</b></div>` : ''}
    ${b.note ? `<div class="muted">${esc(b.note)}</div>` : ''}</div>
    ${b.ingredients.map(i => { const r = byId('receipts', i.receiptId); return r ? receiptBlock(r, i.qty) : ''; }).join('')}
    ${shipmentsTable(b)}</div>`;
}

function forwardTrace(r) {
  const bs = db.batches.filter(b => b.ingredients.some(i => i.receiptId === r.id));
  const active = bs.filter(live), cust = customersOf(active);
  const shipped = active.reduce((a, b) => a + shippedOfBatch(b.id), 0), stock = active.reduce((a, b) => a + restOfBatch(b), 0);
  return `<div class="card"><h2>Лот сырья ${r.code}: куда ушло (прямое прослеживание)</h2>
    ${flow([flowStep(esc(byId('suppliers', r.supplierId)?.name || '—'), 'поставщик'), flowStep(r.code, 'лот сырья', true),
      flowStep(active.length, plural(active.length, 'партия', 'партии', 'партий')), flowStep(cust.size, plural(cust.size, 'покупатель', 'покупателя', 'покупателей'))])}
    <div class="recall"><b>Для отзыва:</b> ${active.length ? `партии ${active.map(b => b.code).join(', ')}; отгружено <b>${shipped}</b> банок, на складе <b>${stock}</b>.` : 'лот ещё не использован в производстве.'}
      ${cust.size ? `<div class="tbl"><table><thead><tr><th scope="col">Покупатель</th><th scope="col">Банок</th><th scope="col">Документы</th></tr></thead><tbody>${[...cust].map(([c, x]) => `<tr><td>${esc(c)}</td><td>${x.qty}</td><td>${esc(x.docs.join(', ')) || '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>
    ${receiptBlock(r)}
    ${bs.length ? bs.map(b => `<div class="chain"><h3>→ Партия <a href="#" data-trace="${b.code}">${b.code}</a> — ${esc(b.product)}, ${fmtD(b.date)}, ${b.shift}${voidBadge(b)}</h3>
      ${shipmentsTable(b)}</div>`).join('') : '<p class="muted">Ещё не использовано в производстве.</p>'}</div>`;
}

// ---------- данные ----------
function viewSettings() {
  const syncCard = !CAN_SYNC ? '' : `<div class="card"><h2>Синхронизация через GitHub</h2>
    <p class="muted">Данные сохраняются в файл в вашем приватном репозитории — одни и те же на телефоне и компьютере. На каждом устройстве введите токен один раз; он хранится только в этом браузере. Подходит тот же токен, что и для приложения учёта производства.</p>
    <form id="ghForm" class="grid">
      <label style="grid-column:1/-1">Токен (fine-grained, Contents: Read and write)<input name="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(gh.token)}"></label>
      <details style="grid-column:1/-1"><summary class="muted">Дополнительные настройки</summary><div class="grid" style="margin-top:8px">
        ${['owner:Владелец', 'repo:Репозиторий', 'branch:Ветка', 'path:Файл данных'].map(x => { const [k, l] = x.split(':'); return `<label>${l}<input name="${k}" required autocapitalize="none" spellcheck="false" value="${esc(gh[k])}"></label>`; }).join('')}
      </div></details>
      <div class="row" style="grid-column:1/-1"><button class="btn primary">Сохранить и подключить</button>
        <button type="button" class="btn" id="ghPull">Синхронизировать сейчас</button>
        <button type="button" class="btn danger" id="ghOff">Отключить</button></div>
    </form><p id="ghStatus" class="muted"></p></div>`;
  const limCard = `<div class="card"><h2>Пределы КТ и ККТ</h2>
    <p class="muted">Значение ниже предела подсвечивается красным. Для ККТ (стерилизация, давление) это отклонение: партия попадает в «Отклонения ККТ», и при сохранении нужно указать корректирующее действие.</p>
    <form id="limForm" class="grid">${LIMITS.map(([k, l, d]) => `<label>${l}, не ниже<input name="${k}" type="number" step="any" required value="${lim(k)}" placeholder="${d}"></label>`).join('')}
    <div class="row" style="grid-column:1/-1"><button class="btn primary">Сохранить пределы</button></div></form></div>`;
  return '<h1 class="page">Данные</h1>' + syncCard + limCard + `<div class="card"><h2>Резервная копия</h2><div class="row">
    <button class="btn primary" id="exp">${icon('down')} Экспорт JSON</button>
    <label class="btn">${icon('up')} Импорт JSON<input type="file" id="imp" accept=".json" hidden></label>
    <button class="btn" id="demo">Загрузить демо-данные</button>
    <button class="btn danger" id="wipe">Очистить всё</button></div>
    <p class="muted">${ghOn() ? 'Данные синхронизируются с GitHub. Экспорт — дополнительная копия на всякий случай.' : 'Данные хранятся только в этом браузере. Подключите синхронизацию или регулярно делайте экспорт.'}</p>
    <p>Записей: поставщиков ${db.suppliers.length}, приёмок ${db.receipts.length}, партий ${db.batches.length}, отгрузок ${db.shipments.length}.</p></div>`;
}

function demo() {
  const s1 = { id: uid(), name: 'ООО «Ягодный край»', inn: '7701234567', address: 'Брянская обл.', phone: '+7 900 000-00-01', certificate: 'Декларация ЕАЭС №RU-Д-…', approved: true };
  const s2 = { id: uid(), name: 'АО «Сахарный завод»', inn: '3601234567', address: 'Воронеж', phone: '', certificate: 'ГОСТ 33222-2015, ДС', approved: true };
  const rc = (s, material, qty, unit, date, shift, code) => ({ id: uid(), code, date, time: '08:30', shift, supplierId: s.id, material, qty, unit, supplierLot: 'L' + code.slice(-2), invoice: 'ТТН ' + code.slice(2), harvestDate: date, expiry: '', transportTemp: 4, productTemp: 6, brix: material === 'Клубника' ? 8 : '', organoleptic: true, docsOk: true, pestOk: true, status: 'Принято', accepted: true, storage: 'Камера №1', responsible: 'Иванова А.', note: '' });
  const r1 = rc(s1, 'Клубника', 500, 'кг', '2026-09-28', '1 смена', 'R-260928-01');
  const r2 = rc(s2, 'Сахар', 1000, 'кг', '2026-09-28', '1 смена', 'R-260928-02');
  const b1 = { id: uid(), code: 'P-260929-01', date: '2026-09-29', shift: '1 смена', product: 'Варенье клубничное', line: 'Котёл 2', cookTemp: 105, cookTime: 40, brix: 68, fillTemp: 80, pasteurTemp: 104, pasteurTime: 10, pressure: 1.5, capOk: true, jars: 1200, jarSize: 350, bestBefore: '2028-09-29', operator: 'Петров С.', released: true, note: '', ingredients: [{ receiptId: r1.id, qty: 300 }, { receiptId: r2.id, qty: 300 }] };
  const sh = { id: uid(), date: '2026-10-01', batchId: b1.id, customer: 'Сеть «Магнит», РЦ Тула', qty: 600, invoice: 'УПД 1543', vehicle: 'А123ВС', responsible: 'Сидоров' };
  const deleted = tombstones(), now = Date.now();
  db = { suppliers: [s1, s2], receipts: [r1, r2], batches: [b1], shipments: [sh], deleted };
  COLLS.forEach(c => db[c].forEach(r => { r.upd = now; }));
  save();
}

// ---------- обработчики ----------
function bind() {
  app.querySelectorAll('form[data-list]').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    const list = f.dataset.list, o = readForm(f, FORMS[list]);
    if (list === 'batches') {
      const rows = [...f.querySelectorAll('.ing')].map(el => ({ lot: el.querySelector('[name=ingLot]'), q: el.querySelector('[name=ingQty]') }));
      const seen = new Set();
      for (const { lot, q } of rows) {
        if (lot.value && !(+q.value > 0)) return fieldErr(q, 'Укажите количество больше нуля.');
        if (!lot.value && +q.value > 0) return fieldErr(lot, 'Выберите лот сырья.');
        if (lot.value && seen.has(lot.value)) return fieldErr(lot, 'Этот лот уже указан выше — объедините строки.');
        seen.add(lot.value);
        if (lot.value) {
          const r = byId('receipts', lot.value), prev = editing ? (byId('batches', editing).ingredients.find(x => x.receiptId === lot.value)?.qty || 0) : 0;
          if (+q.value > restOfReceipt(r) + +prev) return fieldErr(q, `В лоте ${r.code} осталось только ${restOfReceipt(r) + +prev} ${r.unit}.`);
        }
      }
      o.ingredients = rows.filter(x => x.lot.value).map(x => ({ receiptId: x.lot.value, qty: +x.q.value }));
      if (!o.ingredients.length) return fieldErr(rows[0].lot, 'Укажите хотя бы один лот сырья — без этого прослеживаемость невозможна.');
    }
    const old = editing ? byId(list, editing) : null;
    if (list === 'receipts') {
      o.accepted = o.status === 'Принято';
      if (!(+o.qty > 0)) return fieldErr(f.qty, 'Количество должно быть больше нуля.');
      if (old) {
        const used = usedOfReceipt(old.id);
        if (+o.qty < used) return fieldErr(f.qty, `Из лота уже использовано ${used} ${old.unit} — количество не может быть меньше.`);
        if (used > 0 && !o.accepted) return fieldErr(f.status, `Лот уже использован в производстве — решение «${o.status}» поставить нельзя.`);
      }
      const s = byId('suppliers', o.supplierId);
      if (!s.approved && o.supplierId !== old?.supplierId && !await ask(`Поставщик «${s.name}» не одобрен (аудит не пройден). Всё равно оформить приёмку?`, 'Оформить')) return;
    }
    if (list === 'batches') {
      if (!(+o.jars > 0)) return fieldErr(f.jars, 'Количество банок должно быть больше нуля.');
      if (old && +o.jars < shippedOfBatch(old.id)) return fieldErr(f.jars, `Из партии уже отгружено ${shippedOfBatch(old.id)} банок — выпуск не может быть меньше.`);
      if (deviations(o).length && !o.corrective.trim()) return fieldErr(f.corrective, `Отклонение ККТ (${deviations(o).join('; ')}) — опишите корректирующее действие.`);
    }
    if (list === 'shipments') {
      if (!(+o.qty > 0)) return fieldErr(f.qty, 'Количество банок должно быть больше нуля.');
      const b = byId('batches', o.batchId), prev = editing ? +byId('shipments', editing).qty : 0;
      const avail = restOfBatch(b) + (editing && byId('shipments', editing).batchId === b.id ? prev : 0);
      if (+o.qty > avail) return fieldErr(f.qty, `На складе партии ${b.code} только ${avail} банок.`);
      if (!b.released && !await ask(`Партия ${b.code} не одобрена ОТК. Всё равно отгрузить?`, 'Отгрузить')) return;
    }
    o.upd = Date.now();
    if (editing) Object.assign(byId(list, editing), o);
    else {
      o.id = uid();
      if (list === 'receipts') o.code = nextCode('R', o.date, 'receipts');
      if (list === 'batches') o.code = nextCode('P', o.date, 'batches');
      db[list].push(o);
    }
    rememberVals(list, o);
    toast(editing ? 'Изменения сохранены' : `Запись ${o.code || ''} добавлена`.replace('  ', ' '), 'ok');
    editing = null; formOpen = false; formDirty = false; save(); render();
  });
  const bf = app.querySelector('form[data-list=batches]');
  if (bf) {
    const check = () => {
      const o = readForm(bf, FORMS.batches);
      LIMITS.forEach(([k]) => bf.elements[k].classList.toggle('out', isOut(o, k)));
      const dev = deviations(o).length > 0;
      bf.corrective.required = dev; bf.corrective.closest('label').classList.toggle('need', dev);
    };
    bf.addEventListener('input', check); check();
    // «Годен до» и фасовка — по прошлой партии того же продукта (срок годности в днях)
    const fill = () => {
      const prev = db.batches.filter(b => live(b) && b.id !== editing && b.product.trim().toLowerCase() === bf.product.value.trim().toLowerCase() && b.bestBefore).at(-1);
      if (!prev || !bf.date.value) return;
      if (!bf.bestBefore.value || bf.bestBefore.dataset.auto) { bf.bestBefore.value = addDays(bf.date.value, daysBetween(prev.date, prev.bestBefore)); bf.bestBefore.dataset.auto = '1'; }
      if (!bf.jarSize.value && prev.jarSize) bf.jarSize.value = prev.jarSize;
    };
    bf.product.addEventListener('change', fill); bf.date.addEventListener('change', fill);
    bf.bestBefore.addEventListener('input', () => delete bf.bestBefore.dataset.auto);
    const ings = bf.querySelector('#ings');
    ings.addEventListener('change', e => { if (e.target.name === 'ingLot') e.target.closest('.ing').querySelector('.ing-unit').textContent = e.target.selectedOptions[0]?.dataset.unit || ''; });
    ings.addEventListener('click', e => {
      if (!e.target.closest('[data-rming]')) return;
      const rows = ings.querySelectorAll('.ing');
      if (rows.length > 1) e.target.closest('.ing').remove();
      else { rows[0].querySelector('select').value = ''; rows[0].querySelector('input').value = ''; rows[0].querySelector('.ing-unit').textContent = ''; }
      formDirty = true;
    });
  }
  app.querySelector('form[data-list]')?.addEventListener('input', () => { formDirty = true; });
  app.querySelector('[data-cancel]')?.addEventListener('click', async () => { if (!await canLeave()) return; editing = null; formOpen = false; formDirty = false; render(); });
  app.querySelector('[data-add]')?.addEventListener('click', () => { formOpen = true; formDirty = false; render(); showForm(); });
  app.querySelector('[data-unflag]')?.addEventListener('click', () => { flag = null; render(); pushHash(); });
  app.querySelectorAll('[data-flag]').forEach(b => b.onclick = () => { go(FLAGS[b.dataset.flag].tab, b.dataset.flag); scrollTo(0, 0); });
  app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { go(b.dataset.go); scrollTo(0, 0); if (b.hasAttribute('data-open')) { formOpen = true; render(); showForm(); } });
  const filter = app.querySelector('#filter');
  if (filter) { filter.oninput = () => { filterText = filter.value; applyFilter(); }; applyFilter(); }
  // Подписи колонок для карточного вида таблиц на телефоне
  app.querySelectorAll('.tbl table').forEach(t => {
    const hs = [...t.rows[0].cells].map(c => c.textContent);
    [...t.rows].slice(1).forEach(r => [...r.cells].forEach((c, i) => { c.dataset.label = hs[i] || ''; }));
  });
  app.querySelector('#addIng')?.addEventListener('click', () => app.querySelector('#ings').insertAdjacentHTML('beforeend', app.querySelector('#ingTpl').innerHTML));
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => { if (!await canLeave()) return; editing = b.dataset.edit.split(':')[1]; formDirty = false; render(); showForm(); });
  // Журнал: период, сортировка по колонке, Excel, раскрытие карточки на телефоне
  const pf = app.querySelector('#pFrom'), pt = app.querySelector('#pTo');
  if (pf) { pf.onchange = () => { period.from = pf.value; render(); }; pt.onchange = () => { period.to = pt.value; render(); }; }
  app.querySelector('#pClear')?.addEventListener('click', () => { period = { from: '', to: '' }; render(); });
  app.querySelectorAll('[data-today]').forEach(b => b.onclick = () => { go(b.dataset.today); period = { from: today(), to: today() }; render(); scrollTo(0, 0); });
  const jt = app.querySelector('.tbl.jr table');
  if (jt) {
    const keys = jt.dataset.keys.split(',').filter(Boolean).map(Number);
    [...jt.rows].slice(1).forEach(r => [...r.cells].forEach((c, i) => { if (i && i < r.cells.length - 1 && !keys.includes(i)) c.dataset.extra = ''; }));
    if (sortState[tab]) sortRows(jt, sortState[tab]);
    jt.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
      const i = +b.dataset.sort, cur = sortState[tab];
      sortState[tab] = { i, dir: cur?.i === i && cur.dir === 1 ? -1 : 1 };
      sortRows(jt, sortState[tab]);
    });
    jt.addEventListener('click', e => {
      const b = e.target.closest('[data-expand]');
      if (!b) return;
      const open = b.closest('tr').classList.toggle('open');
      b.setAttribute('aria-expanded', open); b.textContent = open ? 'Свернуть' : 'Подробнее';
    });
  }
  const ss = app.querySelector('#sortSel');
  if (ss) ss.onchange = () => { const [i, dir] = ss.value.split(':').map(Number); if (ss.value) sortState[tab] = { i, dir }; else delete sortState[tab]; render(); };
  app.querySelector('#csv')?.addEventListener('click', () => exportCsv(jt));
  app.querySelector('[data-showvoid]')?.addEventListener('click', () => { flag = 'voided'; render(); pushHash(); });
  app.querySelectorAll('[data-void]').forEach(b => b.onclick = () => { const [list, id] = b.dataset.void.split(':'); voidRecord(list, id); });
  app.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const [list, id] = b.dataset.more.split(':'), r = byId(list, id);
    menu(b, [
      ...(r.voided ? [{ label: 'Восстановить', icon: 'undo', run: () => restoreRecord(list, id) }] : []),
      { label: 'Удалить навсегда', icon: 'trash', danger: true, run: () => deleteRecord(list, id) },
    ]);
  });
  app.querySelectorAll('[data-trace]').forEach(a => a.onclick = async e => {
    e.preventDefault(); if (!await canLeave()) return; setTab('trace'); traceQuery = a.dataset.trace;
    render(); pushHash(); scrollTo(0, 0);
  });
  const sc = app.querySelector('#scan');
  if (sc && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) { sc.hidden = false; sc.onclick = scan; }
  const tf = app.querySelector('#traceForm');
  if (tf) tf.onsubmit = async e => { e.preventDefault(); traceQuery = tf.q.value.trim(); render(); pushHash(); };
  app.querySelector('#exp')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    a.download = `haccp-backup-${today()}.json`; a.click();
  });
  app.querySelector('#imp')?.addEventListener('change', async e => {
    try { db = merge(db, migrate(JSON.parse(await e.target.files[0].text()))); save(); render(); } catch { toast('Не удалось прочитать файл: нужен JSON, сохранённый кнопкой «Экспорт JSON»'); }
  });
  const lf = app.querySelector('#limForm');
  if (lf) lf.onsubmit = e => {
    e.preventDefault();
    db.limits = { ...Object.fromEntries(LIMITS.map(([k]) => [k, +lf.elements[k].value])), upd: Date.now() };
    save(); toast('Пределы сохранены', 'ok');
  };
  const ghForm = app.querySelector('#ghForm');
  if (ghForm) {
    status(syncState, syncText);
    ghForm.onsubmit = e => {
      e.preventDefault();
      gh = Object.fromEntries(new FormData(ghForm));
      try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch {}
      if (!ghOn()) { status('off', 'Введите токен, чтобы включить синхронизацию.'); return; }
      setDirty(true); sync(); // локальные данные и данные на GitHub объединяются — ничего не теряется
    };
    app.querySelector('#ghPull').onclick = () => sync();
    app.querySelector('#ghOff').onclick = async () => {
      if (!await ask('Отключить синхронизацию на этом устройстве? Данные останутся здесь, но перестанут отправляться на GitHub.', 'Отключить')) return;
      gh = { ...gh, token: '' };
      try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch {}
      status('off', 'Синхронизация отключена. Данные остаются на этом устройстве.'); render();
    };
  }
  app.querySelector('#demo')?.addEventListener('click', async () => { if (await ask('Заменить текущие данные демо-набором?', 'Заменить', true)) { demo(); render(); toast('Демо-данные загружены', 'ok'); } });
  app.querySelector('#wipe')?.addEventListener('click', async () => { if (await ask('Удалить ВСЕ данные? Сначала сделайте экспорт — восстановить их будет нельзя.', 'Удалить всё', true)) { db = { ...empty(), deleted: tombstones() }; save(); render(); toast('Все данные удалены', 'ok'); } });
}
// ---------- сортировка и выгрузка журналов ----------
// Ключ сортировки: ДД.ММ.ГГГГ → число ГГГГММДД, число → число, иначе текст
function sortKey(c) {
  const t = (c?.innerText || c?.textContent || '').trim();
  const d = t.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (d) return +(d[3] + d[2] + d[1]);
  return /^-?\d/.test(t) ? parseFloat(t.replace(',', '.')) : t.toLowerCase();
}
function sortRows(t, { i, dir }) {
  const rows = [...t.rows].slice(1);
  rows.sort((a, b) => {
    const x = sortKey(a.cells[i]), y = sortKey(b.cells[i]);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru')) * dir;
  });
  rows.forEach(r => r.parentNode.append(r));
  [...t.rows[0].cells].forEach((th, k) => k === i ? th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort'));
}
// CSV для Excel: точка с запятой, BOM, только видимые после поиска строки
function exportCsv(t) {
  if (!t) return;
  const q = v => `"${String(v).replace(/\s*\n\s*/g, ' / ').replace(/"/g, '""').trim()}"`;
  const cells = r => [...r.cells].slice(0, -1).map(c => q(c.innerText || c.textContent));
  // Заголовки — как написаны, без заглавных букв из стилей
  const lines = [[...t.rows[0].cells].slice(0, -1).map(c => q(c.textContent)), ...[...t.rows].slice(1).filter(r => !r.hidden).map(cells)].map(l => l.join(';'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `${tab}-${today()}.csv`; a.click();
}

// ---------- сканер кода с банки (камера) ----------
async function scan() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { return toast('Нет доступа к камере. Разрешите его в настройках браузера или введите код вручную.'); }
  const d = document.createElement('dialog');
  d.className = 'ask scan';
  d.innerHTML = `<form method="dialog"><h3>Наведите камеру на код</h3><video playsinline muted></video>
    <p class="muted">Штрихкод или QR-код с банки или этикетки лота.</p><div class="row"><button class="btn">Отмена</button></div></form>`;
  document.body.append(d); d.showModal();
  const v = d.querySelector('video'); v.srcObject = stream; await v.play().catch(() => {});
  const det = new BarcodeDetector();
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach(t => t.stop()); };
  d.addEventListener('close', () => { stop(); d.remove(); });
  (async function loop() {
    while (!done) {
      try {
        const [code] = await det.detect(v);
        if (code?.rawValue) { traceQuery = code.rawValue.trim(); d.close(); render(); pushHash(); return; }
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
  })();
}

// ---------- аннулирование, восстановление, удаление ----------
const recName = (list, r) => r.code || (list === 'suppliers' ? r.name : `отгрузка ${r.date} · ${r.customer}`);
// Активные записи, которые ссылаются на эту: пока они есть, аннулировать нельзя — остатки разойдутся
function activeLinks(list, id) {
  if (list === 'receipts') return db.batches.filter(b => live(b) && b.ingredients.some(i => i.receiptId === id)).map(b => b.code);
  if (list === 'batches') return db.shipments.filter(s => live(s) && s.batchId === id).map(s => `отгрузка ${s.date} · ${s.customer}`);
  return [];
}
const WHO_KEY = 'haccp-trace-who';
function askVoid(name) {
  let who = ''; try { who = localStorage.getItem(WHO_KEY) || ''; } catch {}
  const d = document.createElement('dialog');
  d.className = 'ask'; d.setAttribute('aria-labelledby', 'voidTitle');
  d.innerHTML = `<form method="dialog"><h3 id="voidTitle">Аннулировать: ${esc(name)}?</h3>
    <p class="muted">Запись останется в журнале и в прослеживании с пометкой «Аннулировано», но перестанет учитываться в остатках и сводке.</p>
    <label>Причина<textarea name="reason" rows="3" required placeholder="например: ошибка ввода, дубль записи, возврат поставщику"></textarea></label>
    <label>Кто аннулирует (ФИО)<input name="by" required value="${esc(who)}"></label>
    <div class="row"><button value="" class="btn" formnovalidate>Отмена</button><button value="ok" class="btn danger-solid">Аннулировать</button></div></form>`;
  const f = d.querySelector('form');
  // Причина из одних пробелов не считается
  f.addEventListener('submit', e => {
    if (e.submitter?.value !== 'ok') return;
    for (const el of [f.reason, f.by]) if (!el.value.trim()) { e.preventDefault(); el.value = ''; el.reportValidity(); return; }
  });
  document.body.append(d); d.showModal();
  return new Promise(res => d.addEventListener('close', () => {
    const ok = d.returnValue === 'ok';
    res(ok ? { reason: f.reason.value.trim(), by: f.by.value.trim() } : null); d.remove();
  }));
}
async function voidRecord(list, id) {
  const r = byId(list, id), links = activeLinks(list, id);
  if (links.length) return toast(`Сначала аннулируйте записи, где используется ${recName(list, r)}: ${links.join(', ')}`);
  const v = await askVoid(recName(list, r));
  if (!v) return;
  try { localStorage.setItem(WHO_KEY, v.by); } catch {}
  Object.assign(r, { voided: true, voidReason: v.reason, voidBy: v.by, voidAt: Date.now(), upd: Date.now() });
  save(); render(); toast(`Аннулировано: ${recName(list, r)}`, 'ok');
}
// Восстановление проверяет то же, что и форма: хватает ли сырья и банок, живы ли связанные записи
function restoreError(list, r) {
  if (list === 'batches') for (const i of r.ingredients) {
    const x = byId('receipts', i.receiptId);
    if (!x || x.voided) return `Лот ${x?.code || ''} аннулирован — сначала восстановите его.`;
    if (+i.qty > restOfReceipt(x)) return `Недостаточно сырья в лоте ${x.code}: остаток ${restOfReceipt(x)} ${x.unit}`;
  }
  if (list === 'shipments') {
    const b = byId('batches', r.batchId);
    if (!b || b.voided) return `Партия ${b?.code || ''} аннулирована — сначала восстановите её.`;
    if (+r.qty > restOfBatch(b)) return `На складе партии ${b.code} только ${restOfBatch(b)} банок`;
  }
  return null;
}
async function restoreRecord(list, id) {
  const r = byId(list, id), err = restoreError(list, r);
  if (err) return toast(err);
  if (!await ask(`Восстановить: ${recName(list, r)}? Пометка об аннулировании будет снята.`, 'Восстановить')) return;
  r.voided = false; delete r.voidReason; delete r.voidBy; delete r.voidAt; r.upd = Date.now();
  save(); render(); toast(`Восстановлено: ${recName(list, r)}`, 'ok');
}
async function deleteRecord(list, id) {
  const linked = list === 'suppliers' ? db.receipts.some(r => r.supplierId === id)
    : list === 'receipts' ? db.batches.some(x => x.ingredients.some(i => i.receiptId === id))
    : list === 'batches' ? db.shipments.some(s => s.batchId === id) : false;
  if (linked) return toast('Запись используется в цепочке прослеживаемости — удалить нельзя. Её можно аннулировать.');
  if (await ask('Удалить запись навсегда? Она исчезнет из журнала и прослеживания, восстановить её будет нельзя. Если запись должна остаться в журнале — выберите «Аннулировать».', 'Удалить', true)) {
    db[list] = db[list].filter(x => x.id !== id); db.deleted[id] = Date.now(); save(); render(); toast('Запись удалена', 'ok');
  }
}

// ---------- меню «⋯» ----------
let openMenu = null;
function closeMenu(focusAnchor = false) {
  if (!openMenu) return;
  const { el, anchor } = openMenu; openMenu = null;
  el.remove(); anchor.setAttribute('aria-expanded', 'false');
  if (focusAnchor && anchor.isConnected) anchor.focus();
}
function menu(anchor, items) {
  const again = openMenu?.anchor === anchor;
  closeMenu();
  if (again) return; // повторное нажатие на «⋯» закрывает меню
  const el = document.createElement('div');
  el.className = 'menu'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  document.body.append(el);
  // Под кнопкой, а если не помещается (на телефоне — над нижней панелью) — над ней
  const a = anchor.getBoundingClientRect(), bottom = innerHeight - (matchMedia('(max-width:820px)').matches ? 80 : 8);
  const top = a.bottom + 4 + el.offsetHeight > bottom ? a.top - 4 - el.offsetHeight : a.bottom + 4;
  el.style.top = Math.max(8, top) + 'px';
  el.style.left = Math.max(8, Math.min(a.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
  const btns = [...el.querySelectorAll('button')];
  btns[0].focus();
  el.onclick = e => { const b = e.target.closest('button'); if (b) { closeMenu(); items[b.dataset.i].run(); } };
  el.onkeydown = e => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(true);
  };
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); });
addEventListener('scroll', () => closeMenu(), { passive: true });
addEventListener('resize', () => closeMenu());

function showForm() {
  const card = app.querySelector('#formCard');
  card?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card?.querySelector('input:not([type=checkbox]),select')?.focus({ preventScroll: true });
}
// Поиск по журналу без перерисовки — фокус и набранный текст сохраняются
function applyFilter() {
  const q = filterText.trim().toLowerCase();
  const rows = [...app.querySelectorAll('.tbl tr')].filter(r => r.querySelector('td'));
  if (!rows.length) return;
  let shown = 0;
  rows.forEach(r => { const ok = !q || r.textContent.toLowerCase().includes(q); r.hidden = !ok; shown += ok; });
  const p = app.querySelector('#noMatch');
  p.hidden = shown > 0; p.textContent = `Ничего не найдено по «${filterText.trim()}».`;
}

fromHash();
if (migrated) save(); // исправления при загрузке сохраняем и отправляем на GitHub
render();
status(ghOn() ? (isDirty() ? 'pending' : 'ok') : 'off');
if (ghOn()) sync();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ghOn()) sync(); });
window.addEventListener('online', () => ghOn() && sync());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
