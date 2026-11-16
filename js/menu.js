// Меню «⋯», прокрутка к форме, поиск по журналу.
// ---------- меню «⋯» ----------
let openMenu = null;
function closeMenu(focusAnchor = false) {
  if (!openMenu) return;
  const { el, anchor } = openMenu; openMenu = null;
  el.remove(); anchor.setAttribute('aria-expanded', 'false');
  if (focusAnchor && anchor.isConnected) anchor.focus();
}
function menu(anchor, items) {
  const again = openMenu?.anchor === anchor;
  closeMenu();
  if (again) return; // повторное нажатие на «⋯» закрывает меню
  const el = document.createElement('div');
  el.className = 'menu'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  document.body.append(el);
  // Под кнопкой, а если не помещается (на телефоне — над нижней панелью) — над ней
  const a = anchor.getBoundingClientRect(), bottom = innerHeight - (matchMedia('(max-width:820px)').matches ? 80 : 8);
  const top = a.bottom + 4 + el.offsetHeight > bottom ? a.top - 4 - el.offsetHeight : a.bottom + 4;
  el.style.top = Math.max(8, top) + 'px';
  el.style.left = Math.max(8, Math.min(a.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
  const btns = [...el.querySelectorAll('button')];
  btns[0].focus();
  el.onclick = e => { const b = e.target.closest('button'); if (b) { closeMenu(); items[b.dataset.i].run(); } };
  el.onkeydown = e => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(true);
  };
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); });
addEventListener('scroll', () => closeMenu(), { passive: true });
addEventListener('resize', () => closeMenu());

function showForm() {
  const card = app.querySelector('#formCard');
  card?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card?.querySelector('input:not([type=checkbox]),select')?.focus({ preventScroll: true });
}
// Поиск по журналу без перерисовки — фокус и набранный текст сохраняются
function applyFilter() {
  const q = filterText.trim().toLowerCase();
  const rows = [...app.querySelectorAll('.tbl tr')].filter(r => r.querySelector('td'));
  if (!rows.length) return;
  let shown = 0;
  rows.forEach(r => { const ok = !q || r.textContent.toLowerCase().includes(q); r.hidden = !ok; shown += ok; });
  const p = app.querySelector('#noMatch');
  p.hidden = shown > 0; p.textContent = `Ничего не найдено по «${filterText.trim()}».`;
}
