const tg = window.Telegram && Telegram.WebApp;
const app = document.getElementById('app');
const initData = tg ? tg.initData : '';
const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let me = null;

const h = (html) => { app.innerHTML = html; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'tma ' + initData, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function applyTheme(theme) {
  const t = theme === 'auto' ? (tg && tg.colorScheme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = t;
}

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
  const go = document.getElementById('go');
  go.onclick = async () => {
    const name = document.getElementById('name').value.trim();
    const err = document.getElementById('err');
    err.hidden = true;
    if (!name) { err.textContent = 'Введите имя.'; err.hidden = false; return; }
    go.disabled = true;
    const r = await api('/api/join', { name, tz: browserTz, code: startParam });
    go.disabled = false;
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

// ---------- главный экран с настройками ----------
function screenMain() {
  const themes = [['auto', 'Как в Telegram'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  h(`<section class="card">
      <h1>Привет, ${esc(me.label)}!</h1>
      <p class="muted">Заметки, папки и календарь появятся здесь. Пока можно настроить приложение и подключить бота.</p>
    </section>
    <section class="card">
      <h2>Настройки</h2>
      <h3>Тема</h3>
      <div class="seg" id="themes">${themes.map(([v, t]) =>
        `<button data-v="${v}" class="${me.theme === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <h3>Часовой пояс</h3>
      <p>${esc(me.tz)}${me.tz !== browserTz ? `<br><span class="muted">Устройство сообщает: ${esc(browserTz)}</span>` : ''}</p>
      ${me.tz !== browserTz ? '<button id="tzfix" class="ghost">Взять с устройства</button>' : ''}
      <h3>Бот</h3>
      <p id="botstate">${me.can_write ? '✅ Бот подключён и может писать вам.' : 'Разрешите боту писать вам, чтобы он присылал напоминания и принимал заметки.'}</p>
      ${me.can_write ? '' : '<button id="connect">Подключить бота</button>'}
      <p id="err" class="err" hidden></p>
    </section>`);

  document.getElementById('themes').onclick = async (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    applyTheme(v);
    const r = await api('/api/settings', { theme: v });
    if (r.ok) { me = r.data.user; screenMain(); }
  };
  const fix = document.getElementById('tzfix');
  if (fix) fix.onclick = async () => {
    const r = await api('/api/settings', { tz: browserTz });
    if (r.ok) { me = r.data.user; screenMain(); }
  };
  const connect = document.getElementById('connect');
  if (connect) connect.onclick = () => {
    const finish = async () => {
      const r = await api('/api/connect-bot', {});
      if (r.ok && r.data.ok) { me = r.data.user; return screenMain(); }
      const err = document.getElementById('err');
      err.textContent = 'Бот пока не может вам написать. Откройте чат с ботом, нажмите Start и повторите.';
      err.hidden = false;
    };
    if (tg && tg.requestWriteAccess) tg.requestWriteAccess(() => finish()); else finish();
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
