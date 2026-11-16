// Аннулирование, восстановление и удаление записей.
// ---------- аннулирование, восстановление, удаление ----------
const recName = (list, r) => r.code || (list === 'suppliers' ? r.name : `отгрузка ${r.date} · ${r.customer}`);
// Активные записи, которые ссылаются на эту: пока они есть, аннулировать нельзя — остатки разойдутся
function activeLinks(list, id) {
  if (list === 'receipts') return db.batches.filter(b => live(b) && b.ingredients.some(i => i.receiptId === id)).map(b => b.code);
  if (list === 'batches') return db.shipments.filter(s => live(s) && s.batchId === id).map(s => `отгрузка ${s.date} · ${s.customer}`);
  return [];
}
function askVoid(name, by) {
  const d = document.createElement('dialog');
  d.className = 'ask'; d.setAttribute('aria-labelledby', 'voidTitle');
  d.innerHTML = `<form method="dialog"><h3 id="voidTitle">Аннулировать: ${esc(name)}?</h3>
    <p class="muted">Запись останется в журнале и в прослеживании с пометкой «Аннулировано», но перестанет учитываться в остатках и сводке.</p>
    <label>Причина<textarea name="reason" rows="3" required placeholder="например: ошибка ввода, дубль записи, возврат поставщику"></textarea></label>
    <p class="muted">Аннулирует: <b>${esc(by)}</b></p>
    <div class="row"><button value="" class="btn" formnovalidate>Отмена</button><button value="ok" class="btn danger-solid">Аннулировать</button></div></form>`;
  const f = d.querySelector('form');
  // Причина из одних пробелов не считается
  f.addEventListener('submit', e => {
    if (e.submitter?.value === 'ok' && !f.reason.value.trim()) { e.preventDefault(); f.reason.value = ''; f.reason.reportValidity(); }
  });
  document.body.append(d); d.showModal();
  return new Promise(res => d.addEventListener('close', () => { res(d.returnValue === 'ok' ? f.reason.value.trim() : null); d.remove(); }));
}
async function voidRecord(list, id) {
  const r = byId(list, id), links = activeLinks(list, id);
  if (links.length) return toast(`Сначала аннулируйте записи, где используется ${recName(list, r)}: ${links.join(', ')}`);
  const by = await needUser();
  if (!by) return;
  const reason = await askVoid(recName(list, r), by);
  if (!reason) return;
  Object.assign(r, { voided: true, voidReason: reason, voidBy: by, voidAt: Date.now(), upd: Date.now() });
  logHist(r, { act: 'void', by, reason });
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
  const by = await needUser();
  if (!by) return;
  if (!await ask(`Восстановить: ${recName(list, r)}? Пометка об аннулировании будет снята.`, 'Восстановить')) return;
  logHist(r, { act: 'restore', by });
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
