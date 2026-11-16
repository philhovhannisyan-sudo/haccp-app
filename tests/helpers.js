// Общие данные и помощники для проверок.
const T0 = Date.parse('2026-10-01T08:00:00Z');

// Небольшой набор: 2 поставщика, 2 лота, 1 партия, 1 отгрузка
function seedData() {
  const rc = (id, code, supplierId, material, qty) => ({ id, code, date: '2026-09-28', time: '08:30', shift: '1 смена', supplierId, material, qty, unit: 'кг',
    supplierLot: 'L1', invoice: 'ТТН 1', harvestDate: '2026-09-27', expiry: '', transportTemp: 4, productTemp: 6, brix: '', organoleptic: true, docsOk: true, pestOk: true,
    status: 'Принято', accepted: true, storage: 'Камера №1', responsible: 'Иванова А.', note: '', upd: T0 });
  return {
    suppliers: [
      { id: 's1', name: 'ООО «Ягодный край»', inn: '7701234567', address: 'Брянск', phone: '', certificate: 'ДС', approved: true, upd: T0 },
      { id: 's2', name: 'АО «Сахарный завод»', inn: '3601234567', address: 'Воронеж', phone: '', certificate: '', approved: false, upd: T0 },
    ],
    receipts: [rc('r1', 'R-260928-01', 's1', 'Клубника', 500), rc('r2', 'R-260928-02', 's2', 'Сахар', 1000)],
    batches: [{ id: 'b1', code: 'P-260929-01', date: '2026-09-29', shift: '1 смена', product: 'Варенье клубничное', line: 'Котёл 2', operator: 'Петров С.',
      cookTemp: 105, cookTime: 40, brix: 68, fillTemp: 80, pasteurTemp: 104, pasteurTime: 10, pressure: 1.5, capOk: true, corrective: '',
      jars: 1200, jarSize: 350, bestBefore: '2028-09-29', released: true, note: '', ingredients: [{ receiptId: 'r1', qty: 300 }, { receiptId: 'r2', qty: 300 }], upd: T0 }],
    shipments: [{ id: 'sh1', date: '2026-10-01', batchId: 'b1', customer: 'Сеть «Магнит»', qty: 600, invoice: 'УПД 1543', vehicle: 'А123ВС', responsible: 'Сидоров', upd: T0 }],
    deleted: {}, limits: { upd: 0 },
  };
}

// Открыть приложение с заданными данными. Данные кладутся один раз — перезагрузка страницы их не сбрасывает.
async function open(page, { data = seedData(), hash = '', gh = null } = {}) {
  await page.addInitScript(({ data, gh }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    if (data) localStorage.setItem('haccp-trace-v1', JSON.stringify(data));
    if (gh) localStorage.setItem('haccp-trace-gh', JSON.stringify(gh));
  }, { data, gh });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./' + hash);
  return errors;
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('haccp-trace-v1')));
const lastToast = page => page.locator('.toast span').last();

// Заполнить форму партии допустимыми значениями (сырьё — лот r1, 10 кг)
async function fillBatch(page, over = {}) {
  const v = { product: 'Джем тестовый', operator: 'Петров С.', cookTemp: '105', brix: '65', pasteurTemp: '104', pressure: '1.5', jars: '10', bestBefore: '2028-01-01', ingQty: '10', ...over };
  for (const [k, val] of Object.entries(v)) if (k !== 'ingQty') await page.fill(`#formCard [name=${k}]`, val);
  await page.selectOption('#formCard [name=ingLot]', 'r1');
  await page.fill('#formCard [name=ingQty]', v.ingQty);
}
module.exports = { seedData, open, stored, lastToast, fillBatch, T0 };
