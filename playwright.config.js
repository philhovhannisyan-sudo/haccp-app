// Проверки запускают приложение в настоящем браузере: на экране компьютера и телефона.
const { defineConfig } = require('@playwright/test');
const PORT = 4173;
module.exports = defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: `http://localhost:${PORT}/`, locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' },
  projects: [
    { name: 'computer', use: { viewport: { width: 1366, height: 850 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: `node tests/server.js ${PORT}`, port: PORT, reuseExistingServer: !process.env.CI },
});
