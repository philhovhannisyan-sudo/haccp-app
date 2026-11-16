// Данные: хранение на устройстве, приведение к текущему формату, слияние версий.
// HACCP-прослеживаемость: приёмка сырья → производство → реализация.
// Данные хранятся в localStorage браузера и, если введён токен, синхронизируются
// с файлом в приватном репозитории GitHub (как в приложении учёта производства).
const KEY = 'haccp-trace-v1';
const DIRTY_KEY = KEY + '-dirty';
const SHIFTS = ['1 смена', '2 смена', '3 смена'];
const COLLS = ['suppliers', 'receipts', 'batches', 'shipments'];
const CAN_SYNC = true;

// Отметки об удалённых записях старше этого срока очищаются, чтобы файл данных не рос вечно
const TOMBSTONE_DAYS = 180;
// Приводит данные любой версии к текущему формату: у записей есть upd, удаления — в deleted
function migrate(d) {
  d = d || {};
  COLLS.forEach(c => { if (!Array.isArray(d[c])) d[c] = []; d[c].forEach(r => { if (r.upd == null) r.upd = 0; }); });
  if (!d.deleted || typeof d.deleted !== 'object') d.deleted = {};
  // Раньше решение по приёмке было галочкой «принято»; «нет» означало отказ или карантин — считаем карантином
  d.receipts.forEach(r => { if (!r.status) r.status = r.accepted ? 'Принято' : 'Карантин'; r.accepted = r.status === 'Принято'; });
  if (!d.limits || typeof d.limits !== 'object') d.limits = { upd: 0 };
  // Предел 85 был значением по умолчанию для пастеризации; для стерилизации по умолчанию 104
  if (+d.limits.pasteurTemp === 85) delete d.limits.pasteurTemp;
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  for (const [id, t] of Object.entries(d.deleted)) if (!(t >= cutoff)) delete d.deleted[id];
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
