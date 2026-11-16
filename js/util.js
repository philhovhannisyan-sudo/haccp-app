// Общие помощники: даты, ФИО устройства, значения по умолчанию, ошибки у полей.
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
// Кто работает на этом устройстве: ФИО вводится один раз и пишется в историю изменений
const WHO_KEY = 'haccp-trace-who';
function getUser() { try { return (localStorage.getItem(WHO_KEY) || '').trim(); } catch { return ''; } }
function setUser(name) { try { localStorage.setItem(WHO_KEY, name.trim()); } catch {} }
// Последние введённые место хранения и линия подставляются в новые записи; в поля ФИО — ФИО устройства
const LAST_KEY = 'haccp-trace-last';
const REMEMBER = { receipts: ['storage'], batches: ['line'] };
const USER_FIELDS = { receipts: ['responsible'], batches: ['operator'], shipments: ['responsible'] };
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
  (USER_FIELDS[list] || []).forEach(k => { d[k] = getUser(); });
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
