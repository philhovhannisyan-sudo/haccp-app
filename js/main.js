// Запуск приложения. Подключается последним.
fromHash();
render();
status(ghOn() ? (isDirty() ? 'pending' : 'ok') : 'off');
if (ghOn()) sync();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ghOn()) sync(); });
window.addEventListener('online', () => ghOn() && sync());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
