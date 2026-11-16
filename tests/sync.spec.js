// Синхронизация с GitHub (ответы GitHub подменяются, настоящих запросов нет).
const { test, expect } = require('@playwright/test');
const { open, seedData, stored, T0 } = require('./helpers');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
// Подменяет GitHub: хранит «файл» в памяти, считает запросы
async function fakeGitHub(page, { file, large = false, failPut = 0 } = {}) {
  const state = { file, sha: file ? 'sha1' : null, puts: [], gets: 0, raw: 0, failPut };
  await page.route('https://api.github.com/**', async route => {
    const q = route.request();
    if (q.method() === 'PUT') {
      const body = JSON.parse(q.postData());
      if (state.failPut-- > 0) return route.fulfill({ status: 409, json: { message: 'conflict' } });
      state.file = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      state.sha = 'sha' + (state.puts.push(body) + 1);
      return route.fulfill({ status: 200, json: {} });
    }
    if (!state.file) return route.fulfill({ status: 404, json: { message: 'Not Found' } });
    if ((q.headers().accept || '').includes('raw')) { state.raw++; return route.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify(state.file) }); }
    state.gets++;
    return route.fulfill({ status: 200, json: large ? { sha: state.sha, content: '', encoding: 'none' } : { sha: state.sha, content: b64(JSON.stringify(state.file)), encoding: 'base64' } });
  });
  return state;
}
const GH = { token: 'test-token' };
const synced = page => expect(page.locator('#syncBadge')).toHaveClass(/sync-ok/);

test('первая синхронизация: файла ещё нет — локальные данные отправляются', async ({ page }) => {
  const gh = await fakeGitHub(page);
  const errors = await open(page, { gh: GH });
  await synced(page);
  expect(gh.puts).toHaveLength(1);
  expect(gh.file.batches[0].code).toBe('P-260929-01');
  expect(errors).toEqual([]);
});

test('записи с другого устройства появляются, локальные не теряются', async ({ page }) => {
  const remote = seedData();
  remote.suppliers.push({ id: 's3', name: 'С другого устройства', approved: true, upd: T0 });
  remote.batches = [];
  remote.shipments = [];
  const gh = await fakeGitHub(page, { file: remote });
  await open(page, { gh: GH });
  await synced(page);
  const d = await stored(page);
  expect(d.suppliers.map(s => s.id)).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
  expect(d.batches).toHaveLength(1);
  expect(gh.file.batches).toHaveLength(1); // локальная партия ушла на GitHub
});

test('файл больше 1 МБ: содержимое запрашивается отдельно', async ({ page }) => {
  const remote = seedData();
  remote.suppliers[0].name = 'Из большого файла';
  remote.suppliers[0].upd = T0 + 1;
  const gh = await fakeGitHub(page, { file: remote, large: true });
  await open(page, { gh: GH });
  await synced(page);
  expect(gh.raw).toBeGreaterThan(0);
  expect((await stored(page)).suppliers[0].name).toBe('Из большого файла');
});

test('файл успели изменить (конфликт): приложение повторяет и отправляет', async ({ page }) => {
  const gh = await fakeGitHub(page, { file: { suppliers: [], receipts: [], batches: [], shipments: [], deleted: {} }, failPut: 1 });
  await open(page, { gh: GH });
  await synced(page);
  expect(gh.puts).toHaveLength(1);
  expect(gh.gets).toBe(2);
});

test('ошибка GitHub: данные остаются на устройстве, значок красный', async ({ page }) => {
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 401, json: { message: 'Bad credentials' } }));
  await open(page, { gh: GH });
  await expect(page.locator('#syncBadge')).toHaveClass(/sync-error/);
  expect((await stored(page)).batches).toHaveLength(1);
});

test('без токена запросов к GitHub нет', async ({ page }) => {
  let calls = 0;
  await page.route('https://api.github.com/**', route => { calls++; return route.abort(); });
  await open(page);
  await expect(page.locator('#syncBadge')).toHaveClass(/sync-off/);
  expect(calls).toBe(0);
});
