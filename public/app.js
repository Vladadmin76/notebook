const tg = window.Telegram && Telegram.WebApp;
const app = document.getElementById('app');
const initData = tg ? tg.initData : '';
const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOLD_MS = 2000; // сколько держать «Настройки», чтобы открыть панель управления
let me = null;

const h = (html) => { app.innerHTML = html; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'tma ' + initData, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Тема: «авто» следует за темой Telegram и меняется сразу, когда её переключают
function applyTheme(theme) {
  const t = theme === 'auto'
    ? (tg && tg.colorScheme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = t;
}
if (tg && tg.onEvent) tg.onEvent('themeChanged', () => { if (!me || me.theme === 'auto') applyTheme('auto'); });

const haptic = () => { try { tg.HapticFeedback.notificationOccurred('success'); } catch {} };
const confirmBox = (text) => new Promise((res) => {
  if (tg && tg.showConfirm) tg.showConfirm(text, res); else res(confirm(text));
});

function screenMessage(title, text) {
  h(`<section class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></section>`);
}

// ---------- знакомство ----------
function screenJoin(invite) {
  const bad = {
    missing: 'Это приглашение недействительно. Попросите новое.',
    used: 'Это приглашение уже использовано.',
    revoked: 'Это приглашение отозвано. Попросите новое.',
  };
  if (bad[invite]) return screenMessage('Блокнот', bad[invite]);

  h(`<section class="card">
    <h1>Давай познакомимся</h1>
    <p>Как тебя зовут?</p>
    <input id="name" maxlength="40" autocomplete="given-name" placeholder="Например, Олег">
    <p class="muted">Твой часовой пояс: <b>${esc(browserTz)}</b>. Сейчас у тебя ${esc(new Date().toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' }))}. Если это не так, поправишь в настройках.</p>
    <p id="err" class="err" hidden></p>
    <button id="go">Познакомиться</button>
  </section>`);
  $('go').onclick = async () => {
    const name = $('name').value.trim();
    const err = $('err');
    err.hidden = true;
    if (!name) { err.textContent = 'Введите имя.'; err.hidden = false; return; }
    $('go').disabled = true;
    const r = await api('/api/join', { name, tz: browserTz, code: startParam });
    $('go').disabled = false;
    if (r.ok) { me = r.data.user; applyTheme(me.theme); return screenMain(); }
    const msgs = {
      bad_name: 'Имя может содержать буквы, цифры, пробел, точку и дефис (до 40 знаков).',
      label_taken: 'Такое имя уже занято. Добавьте фамилию, например «Олег Иванов».',
      invite_unavailable: 'Это приглашение уже недействительно.',
    };
    err.textContent = msgs[r.data.error] || 'Не получилось. Попробуйте ещё раз.';
    err.hidden = false;
  };
}

// ---------- главный экран ----------
function screenMain() {
  app.onclick = null;
  h(`<header class="topbar">
      <span class="brand">Блокнот</span>
      <button id="settingsBtn" class="gear nosel" aria-label="Настройки">⚙️</button>
    </header>
    <section class="card">
      <h1>Привет, ${esc(me.label)}!</h1>
      <p class="muted">Заметки, папки и календарь появятся здесь.</p>
    </section>`);
  // Нажатие открывает настройки, удержание 2 секунды открывает панель управления (только у админа)
  holdToOpen($('settingsBtn'), screenSettings, me.is_admin ? screenAdmin : null);
}

// ---------- настройки ----------
function screenSettings() {
  app.onclick = null;
  const themes = [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  h(`<section class="card">
      <button class="ghost back" id="back">← Назад</button>
      <h2>Настройки</h2>
      <h3>Тема</h3>
      <div class="seg" id="themes">${themes.map(([v, t]) =>
        `<button data-v="${v}" class="${me.theme === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <p class="muted small">«Авто» следует за темой Telegram.</p>
      <h3>Часовой пояс</h3>
      <p>${esc(me.tz)}${me.tz !== browserTz ? `<br><span class="muted">Устройство сообщает: ${esc(browserTz)}</span>` : ''}</p>
      ${me.tz !== browserTz ? '<button id="tzfix" class="ghost">Взять с устройства</button>' : ''}
      <h3>Бот</h3>
      <p id="botstate">${me.can_write ? '✅ Бот подключён и может писать вам.' : 'Разрешите боту писать вам, чтобы он присылал напоминания и принимал заметки.'}</p>
      ${me.can_write ? '' : '<button id="connect">Подключить бота</button>'}
      <p id="err" class="err" hidden></p>
    </section>`);

  $('back').onclick = screenMain;
  $('themes').onclick = async (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    applyTheme(v);
    me.theme = v;
    const r = await api('/api/settings', { theme: v });
    if (r.ok) { me = r.data.user; screenSettings(); }
  };
  if ($('tzfix')) $('tzfix').onclick = async () => {
    const r = await api('/api/settings', { tz: browserTz });
    if (r.ok) { me = r.data.user; screenSettings(); }
  };
  if ($('connect')) $('connect').onclick = () => {
    const finish = async () => {
      const r = await api('/api/connect-bot', {});
      if (r.ok && r.data.ok) { me = r.data.user; return screenSettings(); }
      $('err').textContent = 'Бот пока не может вам написать. Откройте чат с ботом, нажмите Start и повторите.';
      $('err').hidden = false;
    };
    if (tg && tg.requestWriteAccess) tg.requestWriteAccess(() => finish()); else finish();
  };
}

function holdToOpen(el, onTap, onHold) {
  let timer = null, held = false, x0 = 0, y0 = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    held = false; cancel(); x0 = e.clientX; y0 = e.clientY;
    if (onHold) timer = setTimeout(() => { timer = null; held = true; haptic(); onHold(); }, HOLD_MS);
  });
  // Палец всегда немного дрожит: отменяем удержание, только если он ушёл дальше 12 px
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 12) cancel();
  });
  ['pointerup', 'pointercancel'].forEach((ev) => el.addEventListener(ev, cancel));
  el.addEventListener('click', () => { if (!held) onTap(); held = false; });
  // Запрет системного меню долгого нажатия и выделения (iOS/Android)
  ['contextmenu', 'selectstart', 'dragstart'].forEach((ev) => el.addEventListener(ev, (e) => e.preventDefault()));
}

// ---------- панель управления (админ) ----------
async function screenAdmin() {
  h('<section class="card"><p class="muted">Загрузка…</p></section>');
  const r = await api('/api/admin/overview');
  if (!r.ok) return screenMessage('Блокнот', 'Нет доступа.');
  const { users, invites } = r.data;

  const userRow = (u) => `<div class="row">
      <div class="who"><b>${esc(u.label)}</b>${u.is_admin ? ' <span class="tag">админ</span>' : ''}${u.blocked ? ' <span class="tag red">отключён</span>' : ''}
        <div class="muted small">${esc(u.name || 'без имени')} · ${esc(u.tz)}${u.can_write ? '' : ' · бот не подключён'}</div></div>
      ${u.is_admin ? '' : `<div class="acts">
        <button class="mini" data-act="${u.blocked ? 'unblock' : 'block'}" data-id="${u.id}">${u.blocked ? 'Вернуть доступ' : 'Заблокировать'}</button>
        <button class="mini danger" data-act="remove" data-id="${u.id}" data-label="${esc(u.label)}">Удалить</button></div>`}
    </div>`;

  const inviteRow = (i) => `<div class="row">
      <div class="who"><b>${esc(i.note || 'без подписи')}</b><div class="muted small">ещё не открыто</div></div>
      <div class="acts">
        <button class="mini" data-share="${esc(i.link)}">Отправить</button>
        <button class="mini danger" data-revoke="${esc(i.code)}">Отозвать</button></div>
    </div>`;

  h(`<section class="card"><button class="ghost back" id="back">← Назад</button><h1>Люди</h1>
      ${users.map(userRow).join('') || '<p class="muted">Пока никого.</p>'}</section>
    <section class="card"><h2>Приглашения</h2>
      ${invites.map(inviteRow).join('') || '<p class="muted">Нет неиспользованных приглашений.</p>'}
      <h3>Новое приглашение</h3>
      <input id="note" maxlength="40" placeholder="Для кого, например: Олег">
      <button id="newinv">Создать ссылку</button>
      <div id="linkbox" hidden>
        <p class="muted small">Одноразовая ссылка:</p>
        <p class="link" id="linktext"></p>
        <button class="ghost" id="sharenew">Отправить в Telegram</button>
      </div></section>`);

  $('back').onclick = screenMain;
  const share = (link) => {
    const u = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Приглашение в Блокнот');
    if (tg && tg.openTelegramLink) tg.openTelegramLink(u); else window.open(u, '_blank');
  };

  app.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act) {
      const { act, id, label } = b.dataset;
      if (act === 'remove' && !(await confirmBox(`Удалить «${label}» вместе со всеми заметками? Это нельзя отменить.`))) return;
      if (act === 'block' && !(await confirmBox('Отключить этого человека?'))) return;
      b.disabled = true;
      const rr = await api('/api/admin/' + act, { id: Number(id) });
      if (rr.ok) return screenAdmin();
      b.disabled = false; alert('Не получилось.');
    } else if (b.dataset.revoke) {
      if (!(await confirmBox('Отозвать приглашение?'))) return;
      const rr = await api('/api/admin/revoke', { code: b.dataset.revoke });
      if (rr.ok) return screenAdmin();
    } else if (b.dataset.share) {
      share(b.dataset.share);
    } else if (b.id === 'newinv') {
      b.disabled = true;
      const rr = await api('/api/admin/invite', { note: $('note').value });
      b.disabled = false;
      if (!rr.ok) return alert('Не получилось.');
      $('linkbox').hidden = false;
      $('linktext').textContent = rr.data.link;
      $('sharenew').onclick = () => share(rr.data.link);
      try { await navigator.clipboard.writeText(rr.data.link); } catch {}
    }
  };
}

// ---------- запуск ----------
(async () => {
  if (tg) { tg.ready(); tg.expand(); }
  if (!initData) return screenMessage('Блокнот', 'Откройте приложение через Telegram: по ссылке-приглашению или кнопкой «Блокнот» в чате с ботом.');
  const r = await api('/api/me?code=' + encodeURIComponent(startParam));
  if (r.status === 403 && r.data.error === 'blocked') return screenMessage('Блокнот', 'Доступ закрыт.');
  if (!r.ok) return screenMessage('Блокнот', 'Не удалось войти. Откройте приложение заново из Telegram.');
  if (r.data.state === 'user') { me = r.data.user; applyTheme(me.theme); return screenMain(); }
  applyTheme('auto');
  if (r.data.invite === 'admin' || r.data.invite === 'open') return screenJoin('open');
  screenJoin(r.data.invite === 'none' ? 'missing' : r.data.invite);
})();
