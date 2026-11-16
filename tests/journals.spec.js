// Журналы: формы, проверки при сохранении, аннулирование, удаление.
const { test, expect } = require('@playwright/test');
const { open, seedData, stored, lastToast, fillBatch, voidRec } = require('./helpers');

test('приёмка: новая запись получает код, решение обязательно, остаток равен количеству', async ({ page }) => {
  const errors = await open(page, { hash: '#receipts' });
  await page.click('[data-add]');
  await expect(page.locator('#formCard [name=status]')).toHaveValue('');
  await page.selectOption('#formCard [name=supplierId]', 's1');
  await page.fill('#formCard [name=material]', 'Малина');
  await page.fill('#formCard [name=qty]', '20');
  await page.selectOption('#formCard [name=unit]', 'кг');
  await page.fill('#formCard [name=responsible]', 'Иванова А.');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toBeVisible(); // без решения форма не сохраняется
  await page.selectOption('#formCard [name=status]', 'Карантин');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const r = (await stored(page)).receipts.at(-1);
  expect(r.code).toMatch(/^R-\d{6}-01$/);
  expect([r.material, r.status, r.accepted]).toEqual(['Малина', 'Карантин', false]);
  expect(errors).toEqual([]);
});

test('приёмка от неодобренного поставщика требует подтверждения', async ({ page }) => {
  await open(page, { hash: '#receipts' });
  await page.click('[data-add]');
  await page.selectOption('#formCard [name=supplierId]', 's2');
  await page.fill('#formCard [name=material]', 'Сахар');
  await page.fill('#formCard [name=qty]', '5');
  await page.selectOption('#formCard [name=unit]', 'кг');
  await page.selectOption('#formCard [name=status]', 'Принято');
  await page.fill('#formCard [name=responsible]', 'Иванова А.');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('dialog[open] p')).toContainText('не одобрен');
  await page.click('dialog[open] button[value=""]');
  expect((await stored(page)).receipts).toHaveLength(2);
});

test('приёмка: количество нельзя уменьшить ниже использованного, использованному лоту нельзя поставить отказ', async ({ page }) => {
  await open(page, { hash: '#receipts' });
  await page.click('[data-edit="receipts:r1"]');
  await page.fill('#formCard [name=qty]', '100');
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=qty]').validationMessage)).toContain('уже использовано 300');
  await page.fill('#formCard [name=qty]', '500');
  await page.selectOption('#formCard [name=status]', 'Отказ');
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=status]').validationMessage)).toContain('уже использован');
  expect((await stored(page)).receipts[0].status).toBe('Принято');
});

test('партия: сохраняется с кодом и списывает сырьё', async ({ page }) => {
  const errors = await open(page, { hash: '#batches' });
  await page.click('[data-add]');
  await fillBatch(page);
  await page.check('#formCard [name=capOk]');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const b = (await stored(page)).batches.at(-1);
  expect(b.code).toMatch(/^P-\d{6}-01$/);
  expect(b.ingredients).toEqual([{ receiptId: 'r1', qty: 10 }]);
  expect(await page.evaluate(() => restOfReceipt(byId('receipts', 'r1')))).toBe(190);
  expect(errors).toEqual([]);
});

test('партия: нельзя списать сырья больше остатка', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-add]');
  await fillBatch(page, { ingQty: '201' });
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=ingQty]').validationMessage)).toContain('осталось только 200');
  expect((await stored(page)).batches).toHaveLength(1);
});

test('партия: отклонение ККТ требует корректирующего действия, отклонение КТ — нет', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-add]');
  await fillBatch(page, { cookTemp: '90', brix: '50' }); // КТ ниже предела
  await expect(page.locator('#formCard [name=cookTemp]')).toHaveClass(/out/);
  await expect(page.locator('#formCard label.need')).toHaveCount(0);
  await page.fill('#formCard [name=pressure]', '1.1'); // ККТ ниже предела
  await expect(page.locator('#formCard label.need')).toHaveCount(1);
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toBeVisible();
  expect((await stored(page)).batches).toHaveLength(1);
  await page.fill('#formCard [name=corrective]', 'Повторная стерилизация');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  expect((await stored(page)).batches.at(-1).corrective).toBe('Повторная стерилизация');
  await page.goto('./#overview');
  await expect(page.locator('.attn [data-flag=ccp]')).toHaveText(/отклонением ККТ: 1/);
});

test('партия: выпуск нельзя уменьшить ниже отгруженного', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-edit="batches:b1"]');
  await page.fill('#formCard [name=jars]', '500');
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=jars]').validationMessage)).toContain('уже отгружено 600');
  expect((await stored(page)).batches[0].jars).toBe(1200);
});

test('отгрузка: нельзя отгрузить больше остатка партии', async ({ page }) => {
  await open(page, { hash: '#shipments' });
  await page.click('[data-add]');
  await page.selectOption('#formCard [name=batchId]', 'b1');
  await page.fill('#formCard [name=customer]', 'Магазин');
  await page.fill('#formCard [name=qty]', '601');
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=qty]').validationMessage)).toContain('только 600');
  await page.fill('#formCard [name=qty]', '600');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  expect(await page.evaluate(() => restOfBatch(byId('batches', 'b1')))).toBe(0);
});

test('закрытие заполненной формы спрашивает подтверждение', async ({ page }) => {
  await open(page, { hash: '#suppliers' });
  await page.click('[data-add]');
  await page.fill('#formCard [name=name]', 'Новый');
  await page.click('[data-cancel]');
  await expect(page.locator('dialog[open] p')).toContainText('не сохранятся');
  await page.click('dialog[open] button[value=""]');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('#formCard [name=name]')).toHaveValue('Новый');
});

test('аннулирование: блокируется связями, требует причину, возвращает остаток, восстанавливается', async ({ page }) => {
  const errors = await open(page, { hash: '#batches' });
  await voidRec(page, 'batches:b1');
  await expect(lastToast(page)).toContainText('Сначала аннулируйте');
  await page.goto('./#shipments');
  await voidRec(page, 'shipments:sh1');
  await page.fill('dialog[open] [name=reason]', '   ');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('dialog[open]')).toBeVisible(); // причина из пробелов не принимается
  await page.fill('dialog[open] [name=reason]', 'Дубль записи');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('tr.voided')).toHaveCount(1);
  const s = (await stored(page)).shipments[0];
  expect([s.voided, s.voidReason, s.voidBy]).toEqual([true, 'Дубль записи', 'Петров С.']);
  expect(await page.evaluate(() => restOfBatch(byId('batches', 'b1')))).toBe(1200);
  await page.click('[data-more="shipments:sh1"]');
  await expect(page.locator('.menu button')).toHaveText(['История изменений', 'Восстановить', 'Удалить навсегда']);
  await page.click('.menu button:has-text("Восстановить")');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('tr.voided')).toHaveCount(0);
  expect(await page.evaluate(() => restOfBatch(byId('batches', 'b1')))).toBe(600);
  expect(errors).toEqual([]);
});

test('восстановление отгрузки блокируется, пока её партия аннулирована', async ({ page }) => {
  const data = seedData();
  Object.assign(data.shipments[0], { voided: true, voidReason: 'x', voidBy: 'y', voidAt: 1 });
  Object.assign(data.batches[0], { voided: true, voidReason: 'x', voidBy: 'y', voidAt: 1 });
  await open(page, { data, hash: '#shipments' });
  await page.click('[data-more="shipments:sh1"]');
  await page.click('.menu button:has-text("Восстановить")');
  await expect(lastToast(page)).toContainText('сначала восстановите');
  expect((await stored(page)).shipments[0].voided).toBe(true);
});

test('удаление: спрятано в меню «⋯», запрещено для записей в цепочке, оставляет отметку', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await expect(page.locator('[data-del]')).toHaveCount(0);
  await page.click('[data-more="batches:b1"]');
  // на телефоне в меню ещё «Аннулировать» — его убрали из карточки
  const phone = test.info().project.name === 'phone';
  await expect(page.locator('.menu button')).toHaveText([...(phone ? ['Аннулировать'] : []), 'Удалить навсегда']);
  await page.click('.menu button:has-text("Удалить")');
  await expect(lastToast(page)).toContainText('удалить нельзя');
  await page.goto('./#shipments');
  await page.click('[data-more="shipments:sh1"]');
  await page.click('.menu button:has-text("Удалить")');
  await page.click('dialog[open] button[value=ok]');
  await expect(lastToast(page)).toHaveText('Запись удалена');
  const d = await stored(page);
  expect(d.shipments).toHaveLength(0);
  expect(d.deleted.sh1).toBeGreaterThan(0);
});
