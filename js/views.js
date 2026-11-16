// Экраны: журналы, сводка, прослеживание, вкладка «Данные».
function viewSuppliers() {
  return journal('suppliers', { title: 'Поставщики', formTitle: 'Новый поставщик', reverse: false,
    head: ['Наименование', 'ИНН', 'Адрес', 'Контакт', 'Сертификаты', 'Одобрен', 'Поставок'], keys: [5, 6],
    row: s => `${tr(s)}<td>${esc(s.name)}${histMark(s)}${voidNote(s)}</td><td>${esc(s.inn)}</td><td>${esc(s.address)}</td><td>${esc(s.phone)}</td>
    <td>${esc(s.certificate)}</td><td>${okMark(s.approved)}</td><td>${db.receipts.filter(r => live(r) && r.supplierId === s.id).length}</td>${actions('suppliers', s)}</tr>` });
}

function viewReceipts() {
  return journal('receipts', { title: 'Приёмка сырья', formTitle: 'Приёмка сырья (журнал входного контроля)',
    head: ['Лот', 'Дата / смена', 'Поставщик', 'Сырьё', 'Кол-во', 'Остаток', 'T°', 'Brix', 'Контроль', 'Статус', 'Принял'], keys: [1, 3, 5, 9],
    row: r => `${tr(r)}<td><a href="#" data-trace="${r.code}">${r.code}</a>${histMark(r)}${voidNote(r)}</td><td>${fmtD(r.date)} ${esc(r.time)}<br><span class="muted">${r.shift}</span></td>
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
    row: b => `${tr(b)}<td><a href="#" data-trace="${b.code}">${b.code}</a>${deviations(b).length ? `<br><span class="badge bad" title="${esc(deviations(b).join('; '))}">Отклонение ККТ</span>` : ''}${histMark(b)}${voidNote(b)}</td><td>${fmtD(b.date)}<br><span class="muted">${b.shift}</span></td>
    <td>${esc(b.product)}</td><td class="ings">${b.ingredients.map(i => { const r = byId('receipts', i.receiptId); return `<span class="code">${r?.code}</span> ${esc(r?.material)}: ${i.qty}&nbsp;${r?.unit || ''}`; }).join('<br>')}</td>
    <td>${limCell(b, 'cookTemp', esc(b.cookTemp) + '°')} / ${esc(b.cookTime)}м</td><td>${limCell(b, 'brix', esc(b.brix))}</td><td>${limCell(b, 'pasteurTemp', esc(b.pasteurTemp) + '°')} / ${limCell(b, 'pasteurTime', esc(b.pasteurTime) + 'м')}</td><td>${limCell(b, 'pressure', esc(b.pressure))}</td>
    <td>${b.jars}</td><td>${restOfBatch(b)}</td><td>${fmtD(b.bestBefore)}</td><td>${releaseBadge(b)}</td>${actions('batches', b)}</tr>` });
}

function viewShipments() {
  return journal('shipments', { title: 'Реализация', formTitle: 'Отгрузка / реализация',
    head: ['Дата', 'Партия', 'Продукт', 'Покупатель', 'Банок', 'Накладная', 'Транспорт'], keys: [1, 3, 4],
    row: s => { const b = byId('batches', s.batchId); return `${tr(s)}<td>${fmtD(s.date)}${histMark(s)}${voidNote(s)}</td>
    <td><a href="#" data-trace="${b?.code}">${b?.code}</a></td><td>${esc(b?.product)}</td><td>${esc(s.customer)}</td><td>${s.qty}</td>
    <td>${esc(s.invoice)}</td><td>${esc(s.vehicle)}</td>${actions('shipments', s)}</tr>`; } });
}

// ---------- сводка ----------
function viewOverview() {
  const inStock = db.receipts.filter(FLAGS.instock.fn);
  const ccpFail = db.batches.filter(FLAGS.ccp.fn);
  const unreleased = db.batches.filter(FLAGS.unreleased.fn);
  const jars = db.batches.filter(live).reduce((a, b) => a + restOfBatch(b), 0);
  const kpi = (n, label, to) => `<button class="kpi" ${FLAGS[to] ? `data-flag="${to}"` : `data-go="${to}"`}><b>${n}</b><span>${label}</span></button>`;
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
    <p class="today"><b>Сегодня, ${fmtD(t)}:</b> ${todayBtn('receipts', 'Приёмок')} ${todayBtn('batches', 'Партий')} ${todayBtn('shipments', 'Отгрузок')}</p>
    <div class="card attn"><h2>${icon('alert')} Требует внимания</h2>${todo.length ? `<ul>${todo.map(([k, n, text]) => `<li><button class="link" data-flag="${k}">${text(n)}</button></li>`).join('')}</ul>` : `<p class="ok">${icon('check')} Всё в порядке</p>`}</div>
    <div class="kpis">
    ${kpi(inStock.length, 'Лотов сырья на складе', 'instock')}${kpi(db.batches.filter(live).length, 'Партий выпущено', 'batches')}
    ${kpi(jars, 'Банок на складе ГП', 'stock')}</div>
    <div class="cols">
    <div class="card tbl"><h2>Последние партии</h2>${db.batches.length ? '' : none('Партий пока нет')}<table>
      <thead><tr><th scope="col">Код</th><th scope="col">Дата</th><th scope="col">Продукт</th><th scope="col">Банок</th><th scope="col">ОТК</th></tr></thead><tbody>
      ${recent('batches').map(b => `<tr><td><a href="#" data-trace="${b.code}">${b.code}</a></td><td class="num">${fmtD(b.date)}</td><td>${esc(b.product)}</td>
      <td class="num">${restOfBatch(b)} / ${b.jars}</td><td>${releaseBadge(b)}</td></tr>`).join('')}</tbody></table></div>
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
    <div>Выпуск: ${b.jars} банок × ${esc(b.jarSize) || '—'} г, годен до ${fmtD(b.bestBefore)}, ОТК ${releaseBadge(b)}</div>
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
  const userCard = `<div class="card"><h2>Кто работает на этом устройстве</h2>
    <p class="muted">ФИО записывается в историю изменений и подставляется в поля «Принял», «Технолог», «Отгрузил». Хранится только на этом устройстве. Это не вход с паролем: под этим именем работает любой, у кого устройство в руках.</p>
    <form id="userForm" class="row"><label style="flex:1;min-width:220px">ФИО<input name="who" required autocomplete="name" value="${esc(getUser())}"></label><button class="btn primary">Сохранить</button></form></div>`;
  const limCard = `<div class="card"><h2>Пределы КТ и ККТ</h2>
    <p class="muted">Значение ниже предела подсвечивается красным. Для ККТ (стерилизация, давление) это отклонение: партия попадает в «Отклонения ККТ», и при сохранении нужно указать корректирующее действие.</p>
    <form id="limForm" class="grid">${LIMITS.map(([k, l, d]) => `<label>${l}, не ниже<input name="${k}" type="number" step="any" required value="${lim(k)}" placeholder="${d}"></label>`).join('')}
    <div class="row" style="grid-column:1/-1"><button class="btn primary">Сохранить пределы</button></div></form></div>`;
  return '<h1 class="page">Данные</h1>' + userCard + syncCard + limCard + `<div class="card"><h2>Резервная копия</h2><div class="row">
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
