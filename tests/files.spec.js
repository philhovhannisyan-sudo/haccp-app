// Состав файлов приложения: всё, что подключено на странице, существует и сохраняется для работы без сети.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

test('скрипты страницы существуют и входят в список сервис-воркера в том же порядке', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  expect(scripts.length).toBeGreaterThan(1);
  expect(scripts.at(-1)).toBe('js/main.js');
  for (const s of scripts) expect(fs.existsSync(path.join(root, s)), s).toBe(true);
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const listed = sw.match(/const SCRIPTS = \[([^\]]+)\]/)[1].split(',').map(x => 'js/' + x.trim().replace(/'/g, ''));
  expect(listed).toEqual(scripts);
  expect(fs.readdirSync(path.join(root, 'js')).sort()).toEqual(scripts.map(s => s.slice(3)).sort());
});

test('сервис-воркер: все файлы из списка для работы без сети отдаются сайтом', async ({ page, request }) => {
  await page.goto('./');
  const shell = await page.evaluate(async () => {
    const src = await (await fetch('sw.js')).text();
    const body = src.slice(src.indexOf('const CACHE'), src.indexOf('self.addEventListener'));
    return new Function(body + '; return SHELL;')();
  });
  expect(shell.length).toBeGreaterThan(20);
  for (const f of shell) expect((await request.get('./' + f)).status(), f).toBe(200);
});
