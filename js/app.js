// Состояние экрана, адреса вкладок, перерисовка, общий вид журнала.
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
    ${rec ? `<label class="reason" style="grid-column:1/-1"><span class="lt">Причина изменения <span class="req" aria-hidden="true" hidden>*</span></span><input type="text" name="_reason" placeholder="например: исправлена опечатка"></label>` : ''}
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
const histMark = r => wasEdited(r) ? ` <span class="badge edited" title="Запись изменялась — см. «История изменений» в меню «⋯»">изменено</span>` : '';
const voidNote = r => r.voided ? `<div class="void-note"><span class="badge void">Аннулировано</span> ${esc(r.voidReason)}<span class="muted"> — ${esc(r.voidBy)}, ${fmtTs(r.voidAt)}</span></div>` : '';
