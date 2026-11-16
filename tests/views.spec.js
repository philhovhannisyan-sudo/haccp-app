// Сводка, прослеживание, адреса вкладок, поиск и выгрузка.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { open, seedData } = require('./helpers');

test('сводка: плитки и блок «Требует внимания»', async ({ page }) => {
  const data = seedData();
  data.receipts[0].expiry = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  data.batches[0].released = false;
  const errors = await open(page, { data });
  await expect(page.locator('.kpi b')).toHaveText(['2', '1', '600', '1', '0', '0']);
  await expect(page.locator('.attn li')).toHaveText([/истекающим сроком годности: 1/, /ждут одобрения ОТК: 1/, /без одобрения: 1/]);
  await page.click('.attn [data-flag=unapproved]');
  await expect(page).toHaveURL(/#suppliers\/unapproved$/);
  await expect(page.locator('.tbl.jr tbody tr')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('адреса вкладок: открываются по ссылке, работают «Назад» и обновление страницы', async ({ page }) => {
  await open(page, { hash: '#batches' });
  await expect(page.locator('h1')).toHaveText('Производство');
  await page.click('a[data-trace="P-260929-01"]');
  await expect(page).toHaveURL(/#trace\/P-260929-01$/);
  await page.reload();
  await expect(page.locator('.card h2').first()).toContainText('P-260929-01');
  await page.goBack();
  await expect(page.locator('h1')).toHaveText('Производство');
});

test('прослеживание партии: КТ и ККТ в своих строках, сырьё, покупатели', async ({ page }) => {
  const errors = await open(page, { hash: '#trace/P-260929-01' });
  const chain = page.locator('.chain').first();
  await expect(chain).toContainText('КТ: варка 105°C / 40 мин; Brix 68%; фасовка 80°C; герметичность укупорки');
  await expect(chain).toContainText('ККТ: стерилизация 104°C / 10 мин; атмосферное давление 1.5 атм');
  await expect(page.locator('.chain.raw h3')).toHaveText([/R-260928-01.*использовано 300 кг/, /R-260928-02.*использовано 300 кг/]);
  await expect(page.locator('.recall').first()).toContainText('отгружено 600');
  await expect(page.locator('.recall').first()).toContainText('Сеть «Магнит» (600)');
  expect(errors).toEqual([]);
});

test('прослеживание лота: партии и покупатели для отзыва; поиск по части кода и по дате', async ({ page }) => {
  await open(page, { hash: '#trace/R-260928-01' });
  await expect(page.locator('.recall').first()).toContainText('партии P-260929-01; отгружено 600 банок, на складе 600');
  await page.fill('#traceForm [name=q]', '260929');
  await page.click('#traceForm .btn.primary');
  await expect(page.locator('.card h2').first()).toContainText('Партия готовой продукции P-260929-01');
  await page.fill('#traceForm [name=q]', '29.09.2026');
  await page.click('#traceForm .btn.primary');
  await expect(page.locator('.card h2').first()).toContainText('P-260929-01');
  await page.fill('#traceForm [name=q]', 'нет такого');
  await page.click('#traceForm .btn.primary');
  await expect(page.locator('#app')).toContainText('Ничего не найдено');
});

test('журнал: даты ДД.ММ.ГГГГ, поиск, период, выгрузка для Excel', async ({ page }) => {
  await open(page, { hash: '#receipts' });
  const rows = page.locator('.tbl.jr tbody tr:not([hidden])');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.tbl.jr tbody tr').first().locator('td').nth(1)).toContainText('28.09.2026');
  await page.fill('#filter', 'клубника');
  await expect(rows).toHaveCount(1);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8').split('\r\n');
  expect(csv[0]).toBe('﻿"Лот";"Дата / смена";"Поставщик";"Сырьё";"Кол-во";"Остаток";"T°";"Brix";"Контроль";"Статус";"Принял"');
  expect(csv).toHaveLength(2); // заголовок и одна найденная строка
  expect(csv[1]).toContain('"R-260928-01"');
  await page.fill('#filter', '');
  await page.fill('#pFrom', '2026-09-29');
  await page.dispatchEvent('#pFrom', 'change');
  await expect(page.locator('.tbl.jr')).toHaveCount(0);
  await expect(page.locator('#noMatch')).toBeVisible();
});

test('телефон: карточки свёрнуты, «Поставщики» и «Данные» в меню «Ещё»', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'только для телефона');
  await open(page, { hash: '#receipts' });
  const row = page.locator('.tbl.jr tbody tr').first();
  await expect(row.locator('td:visible')).toHaveCount(6);
  await row.locator('[data-expand]').click();
  await expect(row.locator('td:visible')).toHaveCount(12);
  await expect(page.locator('#tabs button:visible')).toHaveCount(6);
  await page.click('#tabs [data-more-tabs]');
  await page.click('.menu button:has-text("Поставщики")');
  await expect(page).toHaveURL(/#suppliers$/);
});

test('компьютер: сортировка по заголовку колонки', async ({ page, isMobile }) => {
  test.skip(isMobile, 'только для компьютера');
  await open(page, { hash: '#receipts' });
  const col = page.locator('.tbl.jr tbody tr td:nth-child(4)');
  await page.click('[data-sort="3"]');
  await expect(col).toHaveText([/Клубника/, /Сахар/]);
  await page.click('[data-sort="3"]');
  await expect(col).toHaveText([/Сахар/, /Клубника/]);
});

test('внешних запросов нет: шрифты и всё остальное грузится с самого сайта', async ({ page }) => {
  const external = [];
  page.on('request', r => { if (!r.url().startsWith('http://localhost')) external.push(r.url()); });
  await open(page);
  await page.evaluate(() => document.fonts.ready);
  expect(external).toEqual([]);
});
