// История изменений записей и запрос ФИО устройства.
// ---------- история изменений ----------
// У записи hist — список событий: создание, правка (что было → что стало), аннулирование, восстановление.
// История не обрезается и хранится вместе с записью.
const REASON_FIELDS = { batches: ['pasteurTemp', 'pasteurTime', 'pressure'], receipts: ['status'] };
const logHist = (r, e) => { (r.hist ||= []).push({ t: Date.now(), ...e }); };
const wasEdited = r => !!r.hist?.some(h => h.act === 'edit');
const needsReason = (list, ch) => ch.some(([k]) => REASON_FIELDS[list]?.includes(k));
const ingKey = a => (a || []).map(i => `${i.receiptId}:${+i.qty}`).sort().join('|');
// Что изменилось в форме по сравнению с записью: [[поле, было, стало], …]
function changes(list, old, o) {
  const ch = [];
  for (const [k, , type] of FORMS[list]) {
    if (k === '§') continue;
    const same = type === 'checkbox' ? !!old[k] === !!o[k] : String(old[k] ?? '') === String(o[k] ?? '');
    if (!same) ch.push([k, old[k] ?? '', o[k]]);
  }
  if (list === 'batches' && ingKey(old.ingredients) !== ingKey(o.ingredients)) ch.push(['ingredients', old.ingredients, o.ingredients]);
  return ch;
}
// Спросить ФИО, если на устройстве оно ещё не указано; без него правки не сохраняются
function needUser() {
  const u = getUser();
  if (u) return Promise.resolve(u);
  const d = document.createElement('dialog');
  d.className = 'ask'; d.setAttribute('aria-labelledby', 'userTitle');
  d.innerHTML = `<form method="dialog"><h3 id="userTitle">Кто работает на этом устройстве?</h3>
    <p class="muted">ФИО вводится один раз и записывается в историю изменений. Изменить его можно во вкладке «Данные».</p>
    <label>ФИО<input name="who" required autocomplete="name"></label>
    <div class="row"><button value="" class="btn" formnovalidate>Отмена</button><button value="ok" class="btn primary">Сохранить</button></div></form>`;
  const f = d.querySelector('form');
  f.addEventListener('submit', e => { if (e.submitter?.value === 'ok' && !f.who.value.trim()) { e.preventDefault(); f.who.value = ''; f.who.reportValidity(); } });
  document.body.append(d); d.showModal();
  return new Promise(res => d.addEventListener('close', () => {
    const name = d.returnValue === 'ok' ? f.who.value.trim() : '';
    if (name) setUser(name);
    res(name || null); d.remove();
  }));
}
const fieldLabel = (list, k) => k === 'ingredients' ? 'Использованное сырьё' : FORMS[list].find(f => f[0] === k)?.[1] || k;
function fieldValue(list, k, v) {
  if (k === 'ingredients') return (v || []).map(i => { const r = byId('receipts', i.receiptId); return `${r?.code || '?'} ${r?.material || ''}: ${i.qty} ${r?.unit || ''}`.trim(); }).join('; ') || '—';
  const type = FORMS[list].find(f => f[0] === k)?.[2];
  if (type === 'checkbox') return v ? 'Да' : 'Нет';
  if (v === '' || v == null) return '—';
  if (k === 'supplierId') return byId('suppliers', v)?.name || '?';
  if (k === 'batchId') return byId('batches', v)?.code || '?';
  return type === 'date' ? fmtD(v) : String(v);
}
const HIST_ACT = { create: 'Запись создана', edit: 'Изменено', void: 'Аннулировано', restore: 'Восстановлено' };
function showHistory(list, id) {
  const r = byId(list, id);
  const d = document.createElement('dialog');
  d.className = 'ask hist'; d.setAttribute('aria-labelledby', 'histTitle');
  d.innerHTML = `<form method="dialog"><h3 id="histTitle">История изменений: ${esc(recName(list, r))}</h3>
    <ol>${[...(r.hist || [])].reverse().map(h => `<li><div><b>${HIST_ACT[h.act] || esc(h.act)}</b> <span class="muted">— ${esc(h.by)}, ${fmtTs(h.t)}</span></div>
      ${h.ch ? `<ul>${h.ch.map(([k, a, b]) => `<li>${esc(fieldLabel(list, k))}: <s>${esc(fieldValue(list, k, a))}</s> → <b>${esc(fieldValue(list, k, b))}</b></li>`).join('')}</ul>` : ''}
      ${h.reason ? `<div>Причина: ${esc(h.reason)}</div>` : ''}</li>`).join('')}</ol>
    <div class="row"><button class="btn primary">Закрыть</button></div></form>`;
  document.body.append(d); d.showModal();
  d.addEventListener('close', () => d.remove());
}
