// Правила: пределы КТ и ККТ, остатки сырья и банок, коды записей.
// ---------- критические пределы ККТ ----------
// Значение ниже предела подсвечивается. Четвёртый элемент true — ККТ: отклонение по ней
// попадает в «Отклонения ККТ» и требует корректирующего действия; КТ (варка, Brix) только подсвечиваются
const LIMITS = [
  ['cookTemp', 'T° варки, °C', 100], ['brix', 'Brix готового, %', 60], ['fillTemp', 'T° фасовки, °C', 80],
  // Поле называется pasteurTemp по старой памяти, теперь это T° стерилизации
  ['pasteurTemp', 'T° стерилизации, °C', 104, true], ['pasteurTime', 'Время стерилизации, мин', 10, true],
  ['pressure', 'Атмосферное давление, атм', 1.2, true],
];
const lim = k => { const v = db.limits?.[k]; return v === '' || v == null ? LIMITS.find(l => l[0] === k)[2] : +v; };
const isOut = (b, k) => b[k] !== '' && b[k] != null && +b[k] < lim(k);
function deviations(b) {
  const out = LIMITS.filter(([k, , , ccp]) => ccp && isOut(b, k)).map(([k, l]) => `${l}: ${b[k]} < ${lim(k)}`);
  return out;
}
const limCell = (b, k, text) => isOut(b, k) ? `<span class="bad" title="Ниже предела ${lim(k)}">${text}</span>` : text;

// ---------- расчёт остатков ----------
// Аннулированные записи остаются в журнале, но не участвуют в остатках и сводке
const live = r => !r.voided;
const usedOfReceipt = id => db.batches.filter(live).reduce((s, b) => s + b.ingredients.filter(i => i.receiptId === id).reduce((a, i) => a + +i.qty, 0), 0);
const restOfReceipt = r => +r.qty - usedOfReceipt(r.id);
const shippedOfBatch = id => db.shipments.filter(s => live(s) && s.batchId === id).reduce((a, s) => a + +s.qty, 0);
const restOfBatch = b => +b.jars - shippedOfBatch(b.id);

function nextCode(prefix, date, list) {
  const base = `${prefix}-${ymd(date)}`;
  const n = Math.max(0, ...db[list].filter(x => x.code.startsWith(base + '-')).map(x => +x.code.slice(base.length + 1))) + 1;
  return `${base}-${String(n).padStart(2, '0')}`;
}
