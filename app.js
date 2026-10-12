// HACCP-прослеживаемость: приёмка сырья → производство → реализация.
// Данные хранятся в localStorage браузера и, если введён токен, синхронизируются
// с файлом в приватном репозитории GitHub (как в приложении учёта производства).
const KEY = 'haccp-trace-v1';
const DIRTY_KEY = KEY + '-dirty';
const SHIFTS = ['1 смена', '2 смена', '3 смена'];
const COLLS = ['suppliers', 'receipts', 'batches', 'shipments'];
const CAN_SYNC = true;

// Приводит данные любой версии к текущему формату: у записей есть upd, удаления — в deleted
function migrate(d) {
  d = d || {};
  COLLS.forEach(c => { if (!Array.isArray(d[c])) d[c] = []; d[c].forEach(r => { if (r.upd == null) r.upd = 0; }); });
  if (!d.deleted || typeof d.deleted !== 'object') d.deleted = {};
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
  const out = { deleted: { ...a.deleted } };
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
  if (b) { b.className = 'sync sync-' + state; b.querySelector('span').textContent = SYNC_LABEL[state] + (state === 'ok' && lastSync ? ' ' + lastSync : ''); b.title = text; }
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
const icon = n => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const okMark = v => v ? `<span class="mark ok" title="Да">${icon('check')}</span>` : `<span class="mark bad" title="Нет">${icon('x')}</span>`;
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
  t.className = `toast ${kind}`; t.innerHTML = `${icon(kind === 'ok' ? 'check' : 'x')}<span>${esc(msg)}</span>`;
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 4000);
}
function ask(msg, okLabel = 'Да', danger = false) {
  const d = document.createElement('dialog');
  d.className = 'ask';
  d.innerHTML = `<form method="dialog"><p>${esc(msg)}</p><div class="row"><button value="" class="btn">Отмена</button>
    <button value="ok" class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(okLabel)}</button></div></form>`;
  document.body.append(d); d.showModal();
  return new Promise(res => d.addEventListener('close', () => { res(d.returnValue === 'ok'); d.remove(); }));
}

// ---------- расчёт остатков ----------
const usedOfReceipt = id => db.batches.reduce((s, b) => s + b.ingredients.filter(i => i.receiptId === id).reduce((a, i) => a + +i.qty, 0), 0);
const restOfReceipt = r => +r.qty - usedOfReceipt(r.id);
const shippedOfBatch = id => db.shipments.filter(s => s.batchId === id).reduce((a, s) => a + +s.qty, 0);
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
  receipts: [
    ['date', 'Дата приёмки', 'date', true], ['time', 'Время', 'time'], ['shift', 'Смена', SHIFTS, true],
    ['supplierId', 'Поставщик', () => db.suppliers.map(s => [s.id, s.name]), true],
    ['material', 'Сырьё (клубника, сахар, пектин…)', 'text', true], ['qty', 'Количество', 'number', true],
    ['unit', 'Ед.', ['кг', 'л', 'шт'], true], ['supplierLot', 'Партия поставщика', 'text'],
    ['invoice', '№ накладной / ТТН', 'text'], ['harvestDate', 'Дата сбора / изготовления', 'date'],
    ['expiry', 'Годен до', 'date'], ['transportTemp', 'T° в транспорте, °C', 'number'],
    ['productTemp', 'T° продукта, °C', 'number'], ['brix', 'Brix сырья, %', 'number'],
    ['organoleptic', 'Органолептика в норме', 'checkbox'], ['docsOk', 'Документы в порядке', 'checkbox'],
    ['pestOk', 'Нет вредителей / посторонних примесей', 'checkbox'],
    ['accepted', 'ПРИНЯТО (иначе — отказ/карантин)', 'checkbox'],
    ['storage', 'Место хранения', 'text'], ['responsible', 'Принял (ФИО)', 'text', true], ['note', 'Примечание', 'text'],
  ],
  batches: [
    ['date', 'Дата производства', 'date', true], ['shift', 'Смена', SHIFTS, true],
    ['product', 'Продукт (Варенье клубничное…)', 'text', true], ['line', 'Линия / котёл', 'text'],
    ['cookTemp', 'ККТ: T° варки, °C', 'number'], ['cookTime', 'Время варки, мин', 'number'],
    ['brix', 'ККТ: Brix готового, %', 'number'], ['fillTemp', 'T° фасовки, °C', 'number'],
    ['pasteurTemp', 'ККТ: T° пастеризации, °C', 'number'], ['pasteurTime', 'Время пастеризации, мин', 'number'],
    ['metalOk', 'ККТ: металлодетектор пройден', 'checkbox'], ['capOk', 'Герметичность укупорки', 'checkbox'],
    ['jars', 'Выпущено банок, шт', 'number', true], ['jarSize', 'Фасовка (г)', 'number'],
    ['bestBefore', 'Годен до', 'date', true], ['operator', 'Технолог / мастер смены', 'text', true],
    ['released', 'Выпуск одобрен ОТК', 'checkbox'], ['note', 'Примечание / отклонения', 'text'],
  ],
  shipments: [
    ['date', 'Дата отгрузки', 'date', true],
    ['batchId', 'Партия ГП', () => db.batches.map(b => [b.id, `${b.code} · ${b.product} (ост. ${restOfBatch(b)})`]), true],
    ['customer', 'Покупатель / магазин', 'text', true], ['qty', 'Банок, шт', 'number', true],
    ['invoice', '№ накладной', 'text'], ['vehicle', 'Транспорт', 'text'], ['responsible', 'Отгрузил', 'text'],
  ],
};

function field([name, label, type, req], val) {
  const r = req ? 'required' : '';
  if (type === 'checkbox') return `<label><span><input type="checkbox" name="${name}" ${val ? 'checked' : ''}> ${label}</span></label>`;
  let opts = Array.isArray(type) ? type.map(o => [o, o]) : typeof type === 'function' ? type() : null;
  if (opts) return `<label>${label}<select name="${name}" ${r}><option value=""></option>${opts.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  return `<label>${label}<input type="${type}" name="${name}" value="${esc(val ?? (type === 'date' && name === 'date' ? today() : ''))}" ${type === 'number' ? 'step="any"' : ''} ${r}></label>`;
}
function readForm(form, fields) {
  const o = {};
  for (const [name, , type] of fields) {
    const el = form.elements[name];
    o[name] = type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

// ---------- рендер ----------
let tab = 'overview', editing = null, formOpen = false, filterText = '', flag = null;
const app = document.getElementById('app');
// Готовые фильтры, на которые ведут карточки сводки
const FLAGS = {
  instock: { tab: 'receipts', label: 'На складе', fn: r => r.accepted && restOfReceipt(r) > 0 },
  rejected: { tab: 'receipts', label: 'Отказ / карантин', fn: r => !r.accepted },
  stock: { tab: 'batches', label: 'Есть на складе ГП', fn: b => restOfBatch(b) > 0 },
  unreleased: { tab: 'batches', label: 'Ждут одобрения ОТК', fn: b => !b.released },
  ccp: { tab: 'batches', label: 'Отклонения ККТ', fn: b => !b.metalOk || !b.capOk },
};
function go(t, f = null) {
  tab = t; editing = null; formOpen = false; filterText = ''; flag = f;
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  render();
}
document.getElementById('tabs').onclick = e => {
  const btn = e.target.closest('button');
  if (btn?.dataset.tab) { go(btn.dataset.tab); scrollTo(0, 0); }
};
document.getElementById('syncBadge').onclick = () => ghOn() ? sync() : go('settings');

function render() {
  app.innerHTML = { overview: viewOverview, trace: viewTrace, suppliers: viewSuppliers, receipts: viewReceipts, batches: viewBatches, shipments: viewShipments, settings: viewSettings }[tab]();
  bind();
}

function crudForm(list, title, extra = '') {
  const rec = editing ? byId(list, editing) : null;
  return `<div class="card" id="formCard"><h2>${rec ? 'Редактирование ' + esc(rec.code || rec.name) : title}</h2>
    <form class="grid" data-list="${list}">${FORMS[list].map(f => field(f, rec?.[f[0]])).join('')}${extra}
    <div class="row"><button class="btn primary">${rec ? 'Сохранить' : 'Добавить'}</button>
    <button type="button" class="btn" data-cancel>Отмена</button></div></form></div>`;
}
// Журнал: список сначала, форма — по кнопке «Добавить» или «Изменить»
function journal(list, { title, formTitle, head, row, extra = '', reverse = true }) {
  const f = flag && FLAGS[flag].tab === list ? FLAGS[flag] : null;
  const items = (reverse ? [...db[list]].reverse() : db[list]).filter(f ? f.fn : () => true);
  const open = formOpen || editing;
  return `<div class="head"><h1 class="page">${title}</h1>${open ? '' : '<button class="btn primary noprint" data-add>+ Добавить</button>'}</div>
    ${open ? crudForm(list, formTitle, extra) : ''}
    ${db[list].length ? `<div class="toolbar noprint"><input type="search" id="filter" value="${esc(filterText)}" placeholder="Поиск: код, дата, название, статус…" aria-label="Поиск по журналу">
      ${f ? `<button class="chip" data-unflag>${esc(f.label)} ${icon('x')}</button>` : ''}</div>` : ''}
    ${items.length ? `<div class="card tbl"><table><tr>${head.map(h => `<th>${h}</th>`).join('')}<th></th></tr>${items.map(row).join('')}</table></div>` : ''}
    <p class="empty" id="noMatch" ${items.length || (open && !db[list].length) ? 'hidden' : ''}>${db[list].length ? 'Нет записей по этому фильтру.' : 'Записей пока нет — нажмите «+ Добавить», чтобы внести первую.'}</p>`;
}
const actions = (list, id) => `<td class="noprint"><button class="btn icon" data-edit="${list}:${id}" aria-label="Изменить">${icon('edit')}</button> <button class="btn icon danger" data-del="${list}:${id}" aria-label="Удалить">${icon('trash')}</button></td>`;

function viewSuppliers() {
  return journal('suppliers', { title: 'Поставщики', formTitle: 'Новый поставщик', reverse: false,
    head: ['Наименование', 'ИНН', 'Адрес', 'Контакт', 'Сертификаты', 'Одобрен', 'Поставок'],
    row: s => `<tr><td>${esc(s.name)}</td><td>${esc(s.inn)}</td><td>${esc(s.address)}</td><td>${esc(s.phone)}</td>
    <td>${esc(s.certificate)}</td><td>${okMark(s.approved)}</td><td>${db.receipts.filter(r => r.supplierId === s.id).length}</td>${actions('suppliers', s.id)}</tr>` });
}

function viewReceipts() {
  return journal('receipts', { title: 'Приёмка сырья', formTitle: 'Приёмка сырья (журнал входного контроля)',
    head: ['Лот', 'Дата / смена', 'Поставщик', 'Сырьё', 'Кол-во', 'Остаток', 'T°', 'Brix', 'Контроль', 'Статус', 'Принял'],
    row: r => `<tr><td><a href="#" data-trace="${r.code}">${r.code}</a></td><td>${r.date} ${esc(r.time)}<br><span class="muted">${r.shift}</span></td>
    <td>${esc(byId('suppliers', r.supplierId)?.name)}</td><td>${esc(r.material)}<br><span class="muted">${esc(r.supplierLot)}</span></td>
    <td>${r.qty} ${r.unit}</td><td>${restOfReceipt(r)} ${r.unit}</td><td>${esc(r.productTemp)}</td><td>${esc(r.brix)}</td>
    <td>${checks(r)}</td>
    <td>${r.accepted ? '<span class="badge ok">Принято</span>' : '<span class="badge bad">Отказ/карантин</span>'}</td><td>${esc(r.responsible)}</td>${actions('receipts', r.id)}</tr>` });
}

function ingredientRows(ings) {
  const lots = db.receipts.filter(r => r.accepted);
  const row = (i = {}) => `<div class="ing"><select name="ingLot"><option value=""></option>${lots.map(r =>
    `<option value="${r.id}" ${r.id === i.receiptId ? 'selected' : ''}>${r.code} · ${esc(r.material)} · ост. ${restOfReceipt(r)} ${r.unit}</option>`).join('')}</select>
    <input name="ingQty" type="number" step="any" placeholder="кол-во" value="${esc(i.qty)}"></div>`;
  return `<div style="grid-column:1/-1"><label>Использованное сырьё (лоты приёмки)</label><div id="ings">${(ings?.length ? ings : [{}]).map(row).join('')}</div>
    <button type="button" class="btn" id="addIng">+ сырьё</button><template id="ingTpl">${row()}</template></div>`;
}

function viewBatches() {
  const rec = editing ? byId('batches', editing) : null;
  return journal('batches', { title: 'Производство', formTitle: 'Производственная партия (варка)', extra: ingredientRows(rec?.ingredients),
    head: ['Код партии', 'Дата / смена', 'Продукт', 'Сырьё', 'Варка', 'Brix', 'Пастер.', 'Мет.', 'Банок', 'Остаток', 'Годен до', 'ОТК'],
    row: b => `<tr><td><a href="#" data-trace="${b.code}">${b.code}</a></td><td>${b.date}<br><span class="muted">${b.shift}</span></td>
    <td>${esc(b.product)}</td><td>${b.ingredients.map(i => { const r = byId('receipts', i.receiptId); return `${r?.code} ${esc(r?.material)}: ${i.qty}`; }).join('<br>')}</td>
    <td>${esc(b.cookTemp)}° / ${esc(b.cookTime)}м</td><td>${esc(b.brix)}</td><td>${esc(b.pasteurTemp)}° / ${esc(b.pasteurTime)}м</td><td>${okMark(b.metalOk)}</td>
    <td>${b.jars}</td><td>${restOfBatch(b)}</td><td>${b.bestBefore}</td><td>${okMark(b.released)}</td>${actions('batches', b.id)}</tr>` });
}

function viewShipments() {
  return journal('shipments', { title: 'Реализация', formTitle: 'Отгрузка / реализация',
    head: ['Дата', 'Партия', 'Продукт', 'Покупатель', 'Банок', 'Накладная', 'Транспорт'],
    row: s => { const b = byId('batches', s.batchId); return `<tr><td>${s.date}</td>
    <td><a href="#" data-trace="${b?.code}">${b?.code}</a></td><td>${esc(b?.product)}</td><td>${esc(s.customer)}</td><td>${s.qty}</td>
    <td>${esc(s.invoice)}</td><td>${esc(s.vehicle)}</td>${actions('shipments', s.id)}</tr>`; } });
}

// ---------- сводка ----------
function viewOverview() {
  const inStock = db.receipts.filter(r => r.accepted && restOfReceipt(r) > 0);
  const rejected = db.receipts.filter(r => !r.accepted);
  const ccpFail = db.batches.filter(b => !b.metalOk || !b.capOk);
  const unreleased = db.batches.filter(b => !b.released);
  const jars = db.batches.reduce((a, b) => a + restOfBatch(b), 0);
  const kpi = (n, label, to, alert) => `<button class="kpi ${alert && n ? 'alert' : ''}" ${FLAGS[to] ? `data-flag="${to}"` : `data-go="${to}"`}><b>${n}</b><span>${label}</span></button>`;
  const none = text => `<p class="empty">${text}</p>`;
  if (!COLLS.some(c => db[c].length)) return `<h1 class="page">Сводка</h1><div class="card empty-start"><h2>Данных пока нет</h2>
    <p class="muted">Начните с вкладки «Поставщики», затем вносите приёмку сырья, партии и отгрузки. Чтобы посмотреть, как всё работает, загрузите демо-данные.</p>
    <div class="row"><button class="btn primary" data-go="suppliers" data-open>${icon('users')} Добавить поставщика</button><button class="btn" data-go="settings">Демо-данные и импорт</button></div></div>`;
  const recent = (list, n = 6) => [...db[list]].sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  return `<h1 class="page">Сводка</h1><div class="kpis">
    ${kpi(inStock.length, 'Лотов сырья на складе', 'instock')}${kpi(db.batches.length, 'Партий выпущено', 'batches')}
    ${kpi(jars, 'Банок на складе ГП', 'stock')}${kpi(unreleased.length, 'Ждут одобрения ОТК', 'unreleased', true)}
    ${kpi(ccpFail.length, 'Отклонения ККТ', 'ccp', true)}${kpi(rejected.length, 'Отказов при приёмке', 'rejected', true)}</div>
    <div class="cols">
    <div class="card tbl"><h2>Последние партии</h2>${db.batches.length ? '' : none('Партий пока нет')}<table>
      <tr><th>Код</th><th>Дата</th><th>Продукт</th><th>Банок</th><th>ОТК</th></tr>
      ${recent('batches').map(b => `<tr><td><a href="#" data-trace="${b.code}">${b.code}</a></td><td class="num">${b.date}</td><td>${esc(b.product)}</td>
      <td class="num">${restOfBatch(b)} / ${b.jars}</td><td>${b.released ? '<span class="badge ok">Выпущено</span>' : '<span class="badge warn">Ожидает</span>'}</td></tr>`).join('')}</table></div>
    <div class="card tbl"><h2>Последние поставки сырья</h2>${db.receipts.length ? '' : none('Поставок пока нет')}<table>
      <tr><th>Лот</th><th>Дата</th><th>Сырьё</th><th>Остаток</th><th>Статус</th></tr>
      ${recent('receipts').map(r => `<tr><td><a href="#" data-trace="${r.code}">${r.code}</a></td><td class="num">${r.date}</td><td>${esc(r.material)}</td>
      <td class="num">${restOfReceipt(r)} ${r.unit}</td><td>${r.accepted ? '<span class="badge ok">Принято</span>' : '<span class="badge bad">Отказ</span>'}</td></tr>`).join('')}</table></div>
    </div>`;
}

// ---------- прослеживание ----------
let traceQuery = '';
function viewTrace() {
  return `<div class="card noprint"><h2>Прослеживание партии</h2>
    <form class="row" id="traceForm"><label style="flex:1;min-width:220px">Код партии с банки (P-…), лот сырья (R-…), дата производства или название продукта
    <input name="q" value="${esc(traceQuery)}" placeholder="например P-261002-01 или 2026-10-02" list="codes"></label>
    <datalist id="codes">${[...db.batches, ...db.receipts].map(x => `<option value="${x.code}">`).join('')}</datalist>
    <button class="btn primary">Найти</button><button type="button" class="btn" onclick="print()">${icon('print')} Печать</button></form>
    <p class="muted">Назад: банка → партия → смена, ККТ → лоты сырья → поставщики, приёмка. Вперёд: лот сырья → партии → покупатели (для отзыва продукции).</p></div>
    ${traceQuery ? traceResult(traceQuery.trim()) : ''}`;
}

function traceResult(q) {
  const ql = q.toLowerCase();
  const batches = db.batches.filter(b => b.code.toLowerCase() === ql || b.date === q || b.product.toLowerCase().includes(ql));
  const receipts = db.receipts.filter(r => r.code.toLowerCase() === ql);
  if (!batches.length && !receipts.length) return `<div class="card">Ничего не найдено по «${esc(q)}».</div>`;
  return receipts.map(forwardTrace).join('') + batches.map(backTrace).join('');
}

function receiptBlock(r, used) {
  const s = byId('suppliers', r.supplierId) || {};
  return `<div class="chain raw"><h3>Лот сырья ${r.code} — ${esc(r.material)}${used != null ? `, использовано ${used} ${r.unit}` : ''}</h3>
    <div>Поступило: <b>${r.date} ${esc(r.time)}</b>, <span class="pill">${r.shift}</span>, принял: <b>${esc(r.responsible)}</b>, место хранения: ${esc(r.storage) || '—'}</div>
    <div>Объём партии: <b>${r.qty} ${r.unit}</b> (остаток ${restOfReceipt(r)} ${r.unit}); накладная ${esc(r.invoice) || '—'}; партия поставщика ${esc(r.supplierLot) || '—'}</div>
    <div>Поставщик: <b>${esc(s.name)}</b>, ИНН ${esc(s.inn) || '—'}, ${esc(s.address)}; сертификаты: ${esc(s.certificate) || '—'}; одобрен ${okMark(s.approved)}</div>
    <div>Входной контроль: T° трансп. ${esc(r.transportTemp) || '—'}°C, T° прод. ${esc(r.productTemp) || '—'}°C, Brix ${esc(r.brix) || '—'};
      органолептика ${okMark(r.organoleptic)}, документы ${okMark(r.docsOk)}, примеси/вредители ${okMark(r.pestOk)};
      дата сбора ${r.harvestDate || '—'}, годен до ${r.expiry || '—'} — ${r.accepted ? '<span class="badge ok">ПРИНЯТО</span>' : '<span class="badge bad">ОТКАЗ</span>'}</div>
    ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</div>`;
}

function shipmentsTable(b) {
  const sh = db.shipments.filter(s => s.batchId === b.id);
  return `<div class="chain ship"><h3>Реализация (отгружено ${shippedOfBatch(b.id)} из ${b.jars}, на складе ${restOfBatch(b)})</h3>
    ${sh.length ? `<div class="tbl"><table><tr><th>Дата</th><th>Покупатель</th><th>Банок</th><th>Накладная</th><th>Транспорт</th></tr>
    ${sh.map(s => `<tr><td>${s.date}</td><td>${esc(s.customer)}</td><td>${s.qty}</td><td>${esc(s.invoice)}</td><td>${esc(s.vehicle)}</td></tr>`).join('')}</table></div>` : '<span class="muted">Отгрузок нет</span>'}</div>`;
}

function backTrace(b) {
  return `<div class="card"><h2>Партия готовой продукции ${b.code} — ${esc(b.product)}</h2>
    <div class="chain"><h3>Производство</h3>
    <div>Дата: <b>${b.date}</b>, <span class="pill">${b.shift}</span>, линия: ${esc(b.line) || '—'}, ответственный: <b>${esc(b.operator)}</b></div>
    <div>ККТ: варка ${esc(b.cookTemp) || '—'}°C / ${esc(b.cookTime) || '—'} мин; Brix ${esc(b.brix) || '—'}%; фасовка ${esc(b.fillTemp) || '—'}°C;
      пастеризация ${esc(b.pasteurTemp) || '—'}°C / ${esc(b.pasteurTime) || '—'} мин; металлодетектор ${okMark(b.metalOk)}; укупорка ${okMark(b.capOk)}</div>
    <div>Выпуск: ${b.jars} банок × ${esc(b.jarSize) || '—'} г, годен до ${b.bestBefore}, ОТК ${okMark(b.released)}</div>
    ${b.note ? `<div class="muted">${esc(b.note)}</div>` : ''}</div>
    ${b.ingredients.map(i => { const r = byId('receipts', i.receiptId); return r ? receiptBlock(r, i.qty) : ''; }).join('')}
    ${shipmentsTable(b)}</div>`;
}

function forwardTrace(r) {
  const bs = db.batches.filter(b => b.ingredients.some(i => i.receiptId === r.id));
  return `<div class="card"><h2>Лот сырья ${r.code}: куда ушло (прямое прослеживание)</h2>${receiptBlock(r)}
    ${bs.length ? bs.map(b => `<div class="chain"><h3>→ Партия <a href="#" data-trace="${b.code}">${b.code}</a> — ${esc(b.product)}, ${b.date}, ${b.shift}</h3>
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
  return syncCard + `<div class="card"><h2>Резервная копия</h2><div class="row">
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
  const rc = (s, material, qty, unit, date, shift, code) => ({ id: uid(), code, date, time: '08:30', shift, supplierId: s.id, material, qty, unit, supplierLot: 'L' + code.slice(-2), invoice: 'ТТН ' + code.slice(2), harvestDate: date, expiry: '', transportTemp: 4, productTemp: 6, brix: material === 'Клубника' ? 8 : '', organoleptic: true, docsOk: true, pestOk: true, accepted: true, storage: 'Камера №1', responsible: 'Иванова А.', note: '' });
  const r1 = rc(s1, 'Клубника', 500, 'кг', '2026-09-28', '1 смена', 'R-260928-01');
  const r2 = rc(s2, 'Сахар', 1000, 'кг', '2026-09-28', '1 смена', 'R-260928-02');
  const b1 = { id: uid(), code: 'P-260929-01', date: '2026-09-29', shift: '1 смена', product: 'Варенье клубничное', line: 'Котёл 2', cookTemp: 105, cookTime: 40, brix: 68, fillTemp: 85, pasteurTemp: 90, pasteurTime: 15, metalOk: true, capOk: true, jars: 1200, jarSize: 350, bestBefore: '2028-09-29', operator: 'Петров С.', released: true, note: '', ingredients: [{ receiptId: r1.id, qty: 300 }, { receiptId: r2.id, qty: 300 }] };
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
      const lots = [...f.querySelectorAll('[name=ingLot]')], qtys = [...f.querySelectorAll('[name=ingQty]')];
      o.ingredients = lots.map((l, i) => ({ receiptId: l.value, qty: +qtys[i].value })).filter(i => i.receiptId && i.qty > 0);
      if (new Set(o.ingredients.map(i => i.receiptId)).size < o.ingredients.length) return toast('Один и тот же лот сырья указан несколько раз — объедините строки.');
      if (!o.ingredients.length) return toast('Укажите хотя бы один лот сырья — без этого прослеживаемость невозможна.');
      for (const i of o.ingredients) {
        const r = byId('receipts', i.receiptId), prev = editing ? (byId('batches', editing).ingredients.find(x => x.receiptId === i.receiptId)?.qty || 0) : 0;
        if (i.qty > restOfReceipt(r) + +prev) return toast(`Недостаточно сырья в лоте ${r.code}: остаток ${restOfReceipt(r) + +prev} ${r.unit}`);
      }
    }
    if (list === 'shipments') {
      const b = byId('batches', o.batchId), prev = editing ? +byId('shipments', editing).qty : 0;
      if (+o.qty > restOfBatch(b) + (editing && byId('shipments', editing).batchId === b.id ? prev : 0)) return toast(`На складе партии ${b.code} только ${restOfBatch(b)} банок`);
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
    toast(editing ? 'Изменения сохранены' : `Запись ${o.code || ''} добавлена`.replace('  ', ' '), 'ok');
    editing = null; formOpen = false; save(); render();
  });
  app.querySelector('[data-cancel]')?.addEventListener('click', () => { editing = null; formOpen = false; render(); });
  app.querySelector('[data-add]')?.addEventListener('click', () => { formOpen = true; render(); showForm(); });
  app.querySelector('[data-unflag]')?.addEventListener('click', () => { flag = null; render(); });
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
  app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = b.dataset.edit.split(':')[1]; render(); showForm(); });
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const [list, id] = b.dataset.del.split(':');
    const linked = list === 'suppliers' ? db.receipts.some(r => r.supplierId === id)
      : list === 'receipts' ? db.batches.some(x => x.ingredients.some(i => i.receiptId === id))
      : list === 'batches' ? db.shipments.some(s => s.batchId === id) : false;
    if (linked) return toast('Запись используется в цепочке прослеживаемости — удалить нельзя.');
    if (await ask('Удалить запись? Это действие нельзя отменить.', 'Удалить', true)) { db[list] = db[list].filter(x => x.id !== id); db.deleted[id] = Date.now(); save(); render(); toast('Запись удалена', 'ok'); }
  });
  app.querySelectorAll('[data-trace]').forEach(a => a.onclick = e => {
    e.preventDefault(); traceQuery = a.dataset.trace; tab = 'trace';
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trace'));
    render(); scrollTo(0, 0);
  });
  const tf = app.querySelector('#traceForm');
  if (tf) tf.onsubmit = async e => { e.preventDefault(); traceQuery = tf.q.value; render(); };
  app.querySelector('#exp')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    a.download = `haccp-backup-${today()}.json`; a.click();
  });
  app.querySelector('#imp')?.addEventListener('change', async e => {
    try { db = merge(db, migrate(JSON.parse(await e.target.files[0].text()))); save(); render(); } catch { toast('Не удалось прочитать файл: нужен JSON, сохранённый кнопкой «Экспорт JSON»'); }
  });
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

render();
status(ghOn() ? (isDirty() ? 'pending' : 'ok') : 'off');
if (ghOn()) sync();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ghOn()) sync(); });
window.addEventListener('online', () => ghOn() && sync());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
