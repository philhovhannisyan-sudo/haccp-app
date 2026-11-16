// Сортировка и выгрузка журналов, сканер кода камерой.
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
