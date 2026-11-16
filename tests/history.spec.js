// ФИО устройства и история изменений.
const { test, expect } = require('@playwright/test');
const { open, seedData, stored, lastToast } = require('./helpers');

test('без ФИО устройства запись не сохраняется; после ввода ФИО сохраняется и запоминается', async ({ page }) => {
  await open(page, { user: null, hash: '#suppliers' });
  await page.click('[data-add]');
  await page.fill('#formCard [name=name]', 'Новый поставщик');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('dialog[open] h3')).toHaveText('Кто работает на этом устройстве?');
  await page.click('dialog[open] button[value=""]');
  expect((await stored(page)).suppliers).toHaveLength(2);
  await page.click('#formCard .btn.primary');
  await page.fill('dialog[open] [name=who]', '  ');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('dialog[open]')).toBeVisible(); // пустое ФИО не принимается
  await page.fill('dialog[open] [name=who]', 'Иванова А.');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const s = (await stored(page)).suppliers.at(-1);
  expect(s.hist).toHaveLength(1);
  expect([s.hist[0].act, s.hist[0].by]).toEqual(['create', 'Иванова А.']);
  expect(await page.evaluate(() => localStorage.getItem('haccp-trace-who'))).toBe('Иванова А.');
});

test('без ФИО устройства нельзя аннулировать', async ({ page }) => {
  await open(page, { user: null, hash: '#shipments' });
  await page.click('[data-void="shipments:sh1"]');
  await expect(page.locator('dialog[open] h3')).toHaveText('Кто работает на этом устройстве?');
  await page.click('dialog[open] button[value=""]');
  await expect(page.locator('dialog')).toHaveCount(0);
  expect((await stored(page)).shipments[0].voided).toBeFalsy();
});

test('ФИО устройства задаётся во вкладке «Данные» и подставляется в формы, но его можно изменить', async ({ page }) => {
  await open(page, { hash: '#settings' });
  await expect(page.locator('#userForm [name=who]')).toHaveValue('Петров С.');
  await page.fill('#userForm [name=who]', 'Сидорова М.');
  await page.click('#userForm .btn.primary');
  await page.goto('./#receipts');
  await page.click('[data-add]');
  await expect(page.locator('#formCard [name=responsible]')).toHaveValue('Сидорова М.');
  await page.selectOption('#formCard [name=supplierId]', 's1');
  await page.fill('#formCard [name=material]', 'Малина');
  await page.fill('#formCard [name=qty]', '5');
  await page.selectOption('#formCard [name=unit]', 'кг');
  await page.selectOption('#formCard [name=status]', 'Принято');
  await page.fill('#formCard [name=responsible]', 'Кладовщик Н.');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const r = (await stored(page)).receipts.at(-1);
  expect([r.responsible, r.hist[0].by]).toEqual(['Кладовщик Н.', 'Сидорова М.']); // в истории — ФИО устройства
});

test('правка обычного поля: причина не нужна, в истории — что было и что стало', async ({ page }) => {
  const errors = await open(page, { hash: '#batches' });
  await expect(page.locator('.badge.edited')).toHaveCount(0);
  await page.click('[data-edit="batches:b1"]');
  await page.fill('#formCard [name=line]', 'Котёл 3');
  await page.uncheck('#formCard [name=released]');
  await expect(page.locator('#formCard .reason .req')).toBeHidden();
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const b = (await stored(page)).batches[0];
  expect(b.hist).toHaveLength(1);
  expect(b.hist[0]).toMatchObject({ act: 'edit', by: 'Петров С.', ch: [['line', 'Котёл 2', 'Котёл 3'], ['released', true, false]] });
  expect(b.hist[0].reason).toBeUndefined();
  await expect(page.locator('.badge.edited')).toHaveCount(1);
  await page.click('[data-more="batches:b1"]');
  await page.click('.menu button:has-text("История изменений")');
  const h = page.locator('dialog.hist');
  await expect(h).toContainText('Изменено — Петров С.');
  await expect(h).toContainText('Линия / котёл: Котёл 2 → Котёл 3');
  await expect(h).toContainText('Выпуск одобрен ОТК: Да → Нет');
  expect(errors).toEqual([]);
});

test('правка ККТ: причина обязательна и попадает в историю', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-edit="batches:b1"]');
  await page.fill('#formCard [name=pressure]', '1.4');
  await expect(page.locator('#formCard .reason .req')).toBeVisible();
  await page.click('#formCard .btn.primary');
  expect(await page.evaluate(() => document.querySelector('#formCard [name=_reason]').validationMessage)).toContain('укажите причину');
  expect((await stored(page)).batches[0].pressure).toBe(1.5);
  await page.fill('#formCard [name=_reason]', 'Ошибка при вводе с манометра');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const b = (await stored(page)).batches[0];
  expect(b.hist[0]).toMatchObject({ act: 'edit', ch: [['pressure', 1.5, '1.4']], reason: 'Ошибка при вводе с манометра' });
});

test('правка решения по приёмке: причина обязательна', async ({ page }) => {
  const data = seedData();
  data.batches = []; data.shipments = []; // лот не использован, решение можно менять
  await open(page, { data, hash: '#receipts' });
  await page.click('[data-edit="receipts:r1"]');
  await page.selectOption('#formCard [name=status]', 'Карантин');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toBeVisible();
  expect((await stored(page)).receipts[0].status).toBe('Принято');
  await page.fill('#formCard [name=_reason]', 'Повторный контроль');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  expect((await stored(page)).receipts[0].hist[0].ch).toEqual([['status', 'Принято', 'Карантин']]);
});

test('сохранение без изменений не создаёт запись в истории', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-edit="batches:b1"]');
  await page.click('#formCard .btn.primary');
  await expect(lastToast(page)).toHaveText('Изменений нет');
  const b = (await stored(page)).batches[0];
  expect(b.hist).toBeUndefined();
  expect(b.upd).toBe(seedData().batches[0].upd);
});

test('изменение состава сырья попадает в историю', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-edit="batches:b1"]');
  await page.locator('#formCard [name=ingQty]').first().fill('250');
  await page.click('#formCard .btn.primary');
  await expect(page.locator('#formCard')).toHaveCount(0);
  const h = (await stored(page)).batches[0].hist[0];
  expect(h.ch[0][0]).toBe('ingredients');
  await page.click('[data-more="batches:b1"]');
  await page.click('.menu button:has-text("История изменений")');
  await expect(page.locator('dialog.hist')).toContainText('R-260928-01 Клубника: 300 кг; R-260928-02 Сахар: 300 кг → R-260928-01 Клубника: 250 кг; R-260928-02 Сахар: 300 кг');
});

test('аннулирование и восстановление пишутся в историю от имени устройства', async ({ page }) => {
  await open(page, { hash: '#shipments' });
  await page.click('[data-void="shipments:sh1"]');
  await expect(page.locator('dialog[open]')).toContainText('Аннулирует: Петров С.');
  await page.fill('dialog[open] [name=reason]', 'Дубль');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('tr.voided')).toHaveCount(1);
  await page.click('[data-more="shipments:sh1"]');
  await page.click('.menu button:has-text("Восстановить")');
  await page.click('dialog[open] button[value=ok]');
  await expect(page.locator('tr.voided')).toHaveCount(0);
  const s = (await stored(page)).shipments[0];
  expect(s.hist.map(h => [h.act, h.by, h.reason])).toEqual([['void', 'Петров С.', 'Дубль'], ['restore', 'Петров С.', undefined]]);
  await expect(page.locator('.badge.edited')).toHaveCount(0); // «изменено» — только для правок значений
});

test('у записей без истории пункта «История изменений» нет', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await page.click('[data-more="batches:b1"]');
  await expect(page.locator('.menu button')).toHaveText(['Удалить навсегда']);
});

test('история переживает синхронизацию: побеждает более поздняя версия записи целиком', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const a = migrate({ suppliers: [{ id: 'x', name: 'A', upd: 2, hist: [{ t: 1, act: 'create', by: 'П' }, { t: 2, act: 'edit', by: 'П', ch: [['name', 'B', 'A']] }] }] });
    const b = migrate({ suppliers: [{ id: 'x', name: 'B', upd: 1, hist: [{ t: 1, act: 'create', by: 'П' }] }] });
    return merge(b, a).suppliers[0].hist.length;
  });
  expect(r).toBe(2);
});
