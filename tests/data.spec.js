// Правила хранения и слияния данных, остатки, пределы ККТ.
const { test, expect } = require('@playwright/test');
const { open, seedData, T0 } = require('./helpers');

test('слияние: побеждает более поздняя правка записи', async ({ page }) => {
  await open(page);
  const names = await page.evaluate(T0 => {
    const mk = (name, upd) => migrate({ suppliers: [{ id: 'x', name, upd }] });
    return [merge(mk('старое', T0), mk('новое', T0 + 1)).suppliers[0].name, merge(mk('новое', T0 + 1), mk('старое', T0)).suppliers[0].name];
  }, T0);
  expect(names).toEqual(['новое', 'новое']);
});

test('слияние: удалённая запись не возвращается с другого устройства, а правка после удаления — возвращается', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const now = Date.now();
    const gone = migrate({ deleted: { x: now } });
    const stale = migrate({ suppliers: [{ id: 'x', name: 'до удаления', upd: now - 1000 }] });
    const fresh = migrate({ suppliers: [{ id: 'x', name: 'после удаления', upd: now + 1000 }] });
    return [merge(gone, stale).suppliers.length, merge(gone, fresh).suppliers.length];
  });
  expect(r).toEqual([0, 1]);
});

test('отметки об удалении старше 180 дней очищаются, свежие остаются', async ({ page }) => {
  await open(page);
  const keys = await page.evaluate(() => Object.keys(migrate({ deleted: { old: Date.now() - 181 * 864e5, recent: Date.now() - 179 * 864e5 } }).deleted));
  expect(keys).toEqual(['recent']);
});

test('старый формат приёмки: «не принято» становится карантином', async ({ page }) => {
  await open(page);
  const st = await page.evaluate(() => migrate({ receipts: [{ id: 'a', accepted: false }, { id: 'b', accepted: true }] }).receipts.map(r => r.status));
  expect(st).toEqual(['Карантин', 'Принято']);
});

test('загрузка данных не меняет режимы уже внесённых партий', async ({ page }) => {
  const data = seedData();
  Object.assign(data.batches[0], { fillTemp: 85, pasteurTemp: 100, pasteurTime: 5, pressure: 1.0, upd: 1 });
  await open(page, { data });
  const b = await page.evaluate(() => db.batches[0]);
  expect([b.fillTemp, b.pasteurTemp, b.pasteurTime, b.pressure, b.upd]).toEqual([85, 100, 5, 1.0, 1]);
});

test('остатки: сырьё за вычетом партий, банки за вычетом отгрузок', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => [restOfReceipt(byId('receipts', 'r1')), restOfReceipt(byId('receipts', 'r2')), restOfBatch(byId('batches', 'b1'))]);
  expect(r).toEqual([200, 700, 600]);
});

test('остатки: аннулированные партии и отгрузки не учитываются', async ({ page }) => {
  const data = seedData();
  data.shipments[0].voided = true;
  await open(page, { data });
  expect(await page.evaluate(() => restOfBatch(byId('batches', 'b1')))).toBe(1200);
  await page.evaluate(() => { byId('batches', 'b1').voided = true; });
  expect(await page.evaluate(() => restOfReceipt(byId('receipts', 'r1')))).toBe(500);
});

test('пределы: отклонением считаются только ККТ, КТ лишь подсвечиваются', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const ok = { cookTemp: 105, brix: 68, fillTemp: 80, pasteurTemp: 104, pasteurTime: 10, pressure: 1.5, capOk: true };
    return {
      ok: deviations(ok).length,
      kt: deviations({ ...ok, cookTemp: 90, brix: 50, fillTemp: 70, capOk: false }).length,
      ktHighlighted: isOut({ ...ok, cookTemp: 90 }, 'cookTemp'),
      ster: deviations({ ...ok, pasteurTemp: 103 }).length,
      time: deviations({ ...ok, pasteurTime: 9 }).length,
      pressure: deviations({ ...ok, pressure: 1.1 }).length,
      atLimit: deviations({ ...ok, pasteurTemp: 104, pressure: 1.2 }).length,
      empty: deviations({ ...ok, pressure: '' }).length,
    };
  });
  expect(r).toEqual({ ok: 0, kt: 0, ktHighlighted: true, ster: 1, time: 1, pressure: 1, atLimit: 0, empty: 0 });
});

test('пределы из вкладки «Данные» заменяют значения по умолчанию', async ({ page }) => {
  const data = seedData();
  data.limits = { pressure: 2, upd: 5 };
  await open(page, { data });
  expect(await page.evaluate(() => [lim('pressure'), lim('pasteurTemp'), deviations(byId('batches', 'b1')).length])).toEqual([2, 104, 1]);
});

test('коды: следующий номер за день, номера аннулированных не переиспользуются', async ({ page }) => {
  const data = seedData();
  data.receipts[1].voided = true;
  await open(page, { data });
  expect(await page.evaluate(() => [nextCode('R', '2026-09-28', 'receipts'), nextCode('R', '2026-09-30', 'receipts'), nextCode('P', '2026-09-29', 'batches')]))
    .toEqual(['R-260928-03', 'R-260930-01', 'P-260929-02']);
});
