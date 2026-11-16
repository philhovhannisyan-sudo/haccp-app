// Обработчики: сохранение форм и все нажатия на экране.
// ---------- обработчики ----------
function bind() {
  app.querySelectorAll('form[data-list]').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    const by = await needUser();
    if (!by) return;
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
      // Неприменимые к этому виду показатели не храним — иначе банка «провалит» органолептику
      CONTROL.forEach(k => { if (!applies(o, k)) o[k] = k === 'transportTemp' || k === 'productTemp' || k === 'brix' ? '' : false; });
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
    if (old) {
      const ch = changes(list, old, o);
      if (!ch.length) { editing = null; formOpen = false; formDirty = false; render(); return toast('Изменений нет', 'ok'); }
      const reason = f._reason.value.trim();
      if (!reason && needsReason(list, ch)) return fieldErr(f._reason, 'Изменено значение ККТ или решение по приёмке — укажите причину.');
      Object.assign(old, o);
      logHist(old, { act: 'edit', by, ch, ...(reason ? { reason } : {}) });
    } else {
      logHist(o, { act: 'create', by });
      o.id = uid();
      if (list === 'receipts') o.code = nextCode('R', o.date, 'receipts');
      if (list === 'batches') o.code = nextCode('P', o.date, 'batches');
      db[list].push(o);
    }
    rememberVals(list, o);
    toast(editing ? 'Изменения сохранены' : `Запись ${o.code || ''} добавлена`.replace('  ', ' '), 'ok');
    editing = null; formOpen = false; formDirty = false; save(); render();
  });
  const rf = app.querySelector('form[data-list=receipts]');
  if (rf) {
    // Показываем только показатели входного контроля, применимые к виду материала
    const showKind = () => CONTROL.forEach(k => {
      const el = rf.elements[k], on = applies({ kind: rf.kind.value }, k);
      el.closest('label').hidden = !on; el.disabled = !on;
    });
    // Вид подбирается по названию, пока его не выбрали вручную
    let auto = !editing;
    rf.material.addEventListener('input', () => { if (auto) { const g = guessKind(rf.material.value, db.receipts.filter(live)); if (g) { rf.kind.value = g; showKind(); } } });
    rf.kind.addEventListener('change', () => { auto = false; showKind(); });
    showKind();
  }
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
  const ef = editing && app.querySelector('form[data-list]');
  if (ef) {
    const list = ef.dataset.list, old = byId(list, editing);
    const mark = () => { ef.querySelector('.reason .req').hidden = !needsReason(list, changes(list, old, { ...readForm(ef, FORMS[list]), ingredients: old.ingredients })); };
    ef.addEventListener('input', mark); ef.addEventListener('change', mark);
  }
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
  app.querySelector('#fToggle')?.addEventListener('click', () => { filtersOpen = !filtersOpen; render(); });
  const ss = app.querySelector('#sortSel');
  if (ss) ss.onchange = () => { const [i, dir] = ss.value.split(':').map(Number); if (ss.value) sortState[tab] = { i, dir }; else delete sortState[tab]; render(); };
  app.querySelector('#csv')?.addEventListener('click', () => exportCsv(jt));
  app.querySelector('[data-showvoid]')?.addEventListener('click', () => { flag = 'voided'; render(); pushHash(); });
  app.querySelectorAll('[data-void]').forEach(b => b.onclick = () => { const [list, id] = b.dataset.void.split(':'); voidRecord(list, id); });
  app.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const [list, id] = b.dataset.more.split(':'), r = byId(list, id);
    menu(b, [
      // На телефоне «Аннулировать» убрано из карточки в это меню
      ...(live(r) && matchMedia('(max-width:820px)').matches ? [{ label: 'Аннулировать', icon: 'ban', run: () => voidRecord(list, id) }] : []),
      ...(r.hist?.length ? [{ label: 'История изменений', icon: 'history', run: () => showHistory(list, id) }] : []),
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
  const uf = app.querySelector('#userForm');
  if (uf) uf.onsubmit = e => {
    e.preventDefault();
    if (!uf.who.value.trim()) return fieldErr(uf.who, 'Укажите ФИО.');
    setUser(uf.who.value); toast('ФИО сохранено', 'ok');
  };
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
