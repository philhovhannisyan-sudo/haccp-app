// Описания форм журналов и построение полей.
// ---------- описания форм ----------
const FORMS = {
  suppliers: [
    ['name', 'Наименование', 'text', true], ['inn', 'ИНН', 'text'], ['address', 'Адрес', 'text'],
    ['phone', 'Контакт', 'text'], ['certificate', 'Сертификаты / декларации', 'text'],
    ['approved', 'Одобрен (аудит пройден)', 'checkbox'],
  ],
  // ['§', 'Заголовок'] — начало раздела формы; пятый элемент — подсказка в пустом поле
  receipts: [
    ['§', 'Поставка'],
    ['date', 'Дата приёмки', 'date', true], ['time', 'Время', 'time'], ['shift', 'Смена', SHIFTS, true],
    ['supplierId', 'Поставщик', v => db.suppliers.filter(s => live(s) || s.id === v).map(s => [s.id, s.name + (s.approved ? '' : ' (не одобрен)')]), true],
    ['material', 'Сырьё / материал', 'text', true, 'клубника, сахар, банки…'],
    ['kind', 'Вид', () => KINDS.map(([v, t]) => [v, t]), true], ['qty', 'Количество', 'number', true],
    ['unit', 'Ед.', ['кг', 'л', 'шт'], true], ['supplierLot', 'Партия поставщика', 'text'],
    ['invoice', '№ накладной / ТТН', 'text'], ['harvestDate', 'Дата сбора / изготовления', 'date'], ['expiry', 'Годен до', 'date'],
    ['§', 'Входной контроль'],
    ['transportTemp', 'T° в транспорте, °C', 'number'], ['productTemp', 'T° продукта, °C', 'number'], ['brix', 'Brix сырья, %', 'number'],
    ['organoleptic', 'Органолептика в норме', 'checkbox'],
    ['packOk', 'Внешний вид и упаковка в норме (целостность, маркировка)', 'checkbox'], ['docsOk', 'Документы в порядке', 'checkbox'],
    ['pestOk', 'Нет вредителей / посторонних примесей', 'checkbox'],
    ['§', 'Решение'],
    ['status', 'Решение по приёмке', ['Принято', 'Карантин', 'Отказ'], true],
    ['storage', 'Место хранения', 'text', false, 'Камера №1'], ['responsible', 'Принял (ФИО)', 'text', true], ['note', 'Примечание', 'text'],
  ],
  batches: [
    ['§', 'Партия'],
    ['date', 'Дата производства', 'date', true], ['shift', 'Смена', SHIFTS, true],
    ['product', 'Продукт', 'text', true, 'Варенье клубничное'], ['line', 'Линия / котёл', 'text'], ['operator', 'Технолог / мастер смены', 'text', true],
    ['§', 'Варка, КТ и ККТ'],
    ['cookTemp', 'КТ: T° варки, °C', 'number'], ['cookTime', 'Время варки, мин', 'number'],
    ['brix', 'КТ: Brix готового, %', 'number'], ['fillTemp', 'T° фасовки, °C', 'number'],
    ['pasteurTemp', 'ККТ: T° стерилизации, °C', 'number', true], ['pasteurTime', 'Время стерилизации, мин', 'number'],
    ['pressure', 'ККТ: атмосферное давление, атм', 'number', true],
    ['capOk', 'КТ: Герметичность укупорки', 'checkbox'],
    ['corrective', 'Корректирующее действие (при отклонении ККТ)', 'text'],
    ['§', 'Выпуск'],
    ['jars', 'Выпущено банок, шт', 'number', true], ['jarSize', 'Фасовка (г)', 'number'],
    ['bestBefore', 'Годен до', 'date', true], ['released', 'Выпуск одобрен ОТК', 'checkbox'], ['note', 'Примечание', 'text'],
  ],
  shipments: [
    ['date', 'Дата отгрузки', 'date', true],
    ['batchId', 'Партия ГП', v => db.batches.filter(b => (live(b) && restOfBatch(b) > 0) || b.id === v).map(b => [b.id, `${b.code} · ${b.product} (ост. ${restOfBatch(b)})`]), true],
    ['customer', 'Покупатель / магазин', 'text', true], ['qty', 'Банок, шт', 'number', true],
    ['invoice', '№ накладной', 'text'], ['vehicle', 'Транспорт', 'text'], ['responsible', 'Отгрузил', 'text'],
  ],
};

// Температуры могут быть отрицательными (замороженное сырьё), остальные числа — нет
const SIGNED = ['transportTemp', 'productTemp', 'cookTemp', 'fillTemp', 'pasteurTemp'];
// Текстовые поля с подсказками из уже введённых значений
const SUGGEST = ['product', 'material', 'customer', 'storage', 'line', 'vehicle', 'responsible', 'operator'];
function field([name, label, type, req, ph], val, list) {
  if (name === '§') return `<h3 class="fs">${label}</h3>`;
  const r = req ? 'required' : '';
  if (req && type !== 'checkbox') label += ' <span class="req" aria-hidden="true">*</span>';
  if (list === 'batches' && LIMITS.some(l => l[0] === name)) label += ` <span class="lim">≥ ${lim(name)}</span>`;
  if (type !== 'checkbox') label = `<span class="lt">${label}</span>`;
  if (type === 'text' && SUGGEST.includes(name)) {
    const vals = [...new Set(db[list].filter(live).map(x => x[name]).filter(Boolean))];
    if (vals.length) return `<label>${label}<input type="text" name="${name}" value="${esc(val)}" list="dl-${name}" autocomplete="off" ${ph ? `placeholder="${esc(ph)}"` : ''} ${r}>
      <datalist id="dl-${name}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist></label>`;
  }
  if (type === 'checkbox') return `<label><span><input type="checkbox" name="${name}" ${val ? 'checked' : ''}> ${label}</span></label>`;
  let opts = Array.isArray(type) ? type.map(o => [o, o]) : typeof type === 'function' ? type(val) : null;
  if (opts) return `<label>${label}<select name="${name}" ${r}><option value=""></option>${opts.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  return `<label>${label}<input type="${type}" name="${name}" value="${esc(val)}" ${ph ? `placeholder="${esc(ph)}"` : ''} ${type === 'number' ? `step="any"${SIGNED.includes(name) ? '' : ' min="0"'}` : ''} ${r}></label>`;
}
function readForm(form, fields) {
  const o = {};
  for (const [name, , type] of fields) {
    if (name === '§') continue;
    const el = form.elements[name];
    o[name] = type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}
