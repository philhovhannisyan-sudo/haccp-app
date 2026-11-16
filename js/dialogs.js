// Уведомления и окно подтверждения (вместо alert/confirm).
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
