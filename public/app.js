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
  if (r.ok && body && TRASH_ACTIONS.test(path)) setTimeout(refreshTrashIcon, 0); // после удаления, возврата или очистки обновляем значок
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

// Ощутимая вибрация: тяжёлый удар, ещё один, затем «успех» (стили из документации Telegram Mini Apps)
const haptic = () => {
  const hf = tg && tg.HapticFeedback;
  if (!hf) return;
  const hit = (style) => { try { hf.impactOccurred(style); } catch {} };
  hit('heavy');
  setTimeout(() => hit('heavy'), 90);
  setTimeout(() => { try { hf.notificationOccurred('success'); } catch {} }, 190);
};
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
    <p class="muted small">Тексты заметок и голосовые сообщения обрабатываются сервисами DeepSeek (правка текста) и Groq (распознавание речи). Не записывайте то, что не хотите им передавать.</p>
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

// ---------- навигация ----------
let current = null;
const hist = [];
function syncBack() {
  if (tg && tg.BackButton) { if (hist.length) tg.BackButton.show(); else tg.BackButton.hide(); }
}
function show(fn) { if (current) hist.push(current); current = fn; app.onclick = null; fn(); window.scrollTo(0, 0); syncBack(); }
function back() { const f = hist.pop(); if (f) { current = f; app.onclick = null; f(); window.scrollTo(0, 0); } syncBack(); }
function tab(fn) { hist.length = 0; current = fn; app.onclick = null; fn(); window.scrollTo(0, 0); syncBack(); }
if (tg && tg.BackButton) tg.BackButton.onClick(back);

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const fmtDate = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: me.tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
// Своё окно ввода и уведомление: системные prompt()/alert() во встроенном браузере Telegram работают нестабильно
function askText(title, value = '') {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>${esc(title)}</h3><input id="askIn" maxlength="30" value="${esc(value)}" autocomplete="off">
      <div class="btnrow"><button class="ghost mini" id="askNo">Отмена</button><button class="mini" id="askYes">Готово</button></div></div>`;
    document.body.appendChild(m);
    const input = m.querySelector('#askIn');
    input.focus(); input.select();
    const done = (v) => { m.remove(); resolve(v); };
    m.querySelector('#askNo').onclick = () => done(null);
    m.querySelector('#askYes').onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); };
  });
}
const notify = (text) => { if (tg && tg.showAlert) tg.showAlert(text); else alert(text); };
const toast = (text) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
};
const errText = (code) => ({
  bad_name: 'Название: до 30 знаков, буквы, цифры, пробел.', exists: 'Такое название уже есть.', protected: 'Эту папку нельзя менять.',
  past: 'Это время уже прошло.', bad_time: 'Не удалось понять время.', bad_text: 'Текст пустой или слишком длинный (до 2000 знаков).',
}[code] || 'Не получилось. Попробуйте ещё раз.');

// Значок корзины: пустой или полный. Состояние подтягивается при показе экрана и после действий, меняющих корзину.
let trashFull = false;
const binIcon = () => `<svg aria-hidden="true"><use href="#${trashFull ? 'bin-full' : 'bin-empty'}"></use></svg>`;
async function refreshTrashIcon() {
  const r = await api('/api/trash/count');
  if (!r.ok) return;
  trashFull = !!r.data.full;
  document.querySelectorAll('.trashbtn').forEach((b) => { b.innerHTML = binIcon(); b.setAttribute('aria-label', trashFull ? 'Корзина (есть удалённое)' : 'Корзина (пусто)'); });
}
const TRASH_ACTIONS = /^\/api\/(notes\/delete|folders\/delete|shopping\/(delete|clear|lists\/delete)|trash\/(restore|purge|empty))$/;

const TABS = [['notes', '📁', 'Заметки'], ['shop', '🛒', 'Покупки'], ['cal', '📅', 'Календарь']];
function frame(active, inner) {
  h(`<header class="topbar"><span class="brand">Блокнот</span>
      <div class="topbtns"><button id="trashBtn" class="gear trashbtn" aria-label="Корзина">${binIcon()}</button>
        <button id="settingsBtn" class="gear nosel" aria-label="Настройки">⚙️</button></div></header>
    ${inner}
    <nav class="tabbar">${TABS.map(([k, ic, t]) => `<button data-tab="${k}" class="${k === active ? 'on' : ''}"><span>${ic}</span>${t}</button>`).join('')}</nav>`);
  // Нажатие открывает настройки, удержание 2 секунды открывает панель управления (только у админа)
  holdToOpen($('settingsBtn'), () => show(screenSettings), me.is_admin ? () => show(screenAdmin) : null);
  $('trashBtn').onclick = () => show(screenTrash);
  refreshTrashIcon();
  document.querySelector('.tabbar').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const fn = { notes: screenNotes, shop: screenShopping, cal: screenCalendar }[b.dataset.tab];
    if (fn) tab(fn);
  };
}
const subHeader = (title, extra = '') => `<header class="topbar sub"><button class="ghost back" id="backBtn">← Назад</button><span class="brand">${esc(title)}</span>${extra || '<span></span>'}</header>`;
const bindBack = () => { const b = $('backBtn'); if (b) b.onclick = back; };

// ---------- вкладка «Заметки»: папки и поиск ----------
async function screenNotes() {
  frame('notes', `<div class="card"><input id="search" type="search" placeholder="Поиск по заметкам" autocomplete="off">
      <div id="results"></div></div><div id="folders"><p class="muted">Загрузка…</p></div>`);
  const [ov] = await Promise.all([api('/api/overview')]);
  if (!ov.ok) return;
  // Пустая папка «Входящие» не показывается; появится сама, как только в ней окажется ссылка
  const folders = ov.data.folders.filter((f) => !(f.kind === 'inbox' && f.n === 0));
  $('folders').innerHTML = folders.map((f) => `<button class="row-card" data-folder="${f.id}" data-name="${esc(f.name)}" data-kind="${esc(f.kind ?? '')}">
      <span>📁 ${esc(f.name)}</span><span class="count">${f.n}</span></button>`).join('')
    + `<button class="ghost wide" id="newFolder">+ Новая папка</button>`;
  $('folders').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.folder) show(() => screenFolder(Number(b.dataset.folder), b.dataset.name, b.dataset.kind || null));
    else if (b.id === 'newFolder') {
      const name = await askText('Название папки');
      if (!name) return;
      const r = await api('/api/folders/create', { name });
      if (r.ok) screenNotes(); else notify(errText(r.data.error));
    }
  };
  let timer;
  $('search').oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (!q) { $('results').innerHTML = ''; $('folders').hidden = false; return; }
    timer = setTimeout(async () => {
      const r = await api('/api/notes?q=' + encodeURIComponent(q));
      if (!r.ok) return;
      $('folders').hidden = true;
      $('results').innerHTML = noteCards(r.data.notes) || '<p class="muted">Ничего не найдено.</p>';
    }, 300);
  };
  $('results').onclick = (e) => { const c = e.target.closest('[data-note]'); if (c) show(() => screenNote(Number(c.dataset.note))); };
}

// Превращаем адреса в нажимающиеся ссылки (текст уже экранирован)
const linkify = (escaped) => escaped.replace(/https?:\/\/[^\s<>"]+/g, (u) => {
  const m = /[.,;:!?)»\]]+$/.exec(u);
  const tail = m ? m[0] : '';
  const url = tail ? u.slice(0, -tail.length) : u;
  return `<a href="${url}" class="lnk" data-link="1">${url}</a>${tail}`;
});
function openExternal(url) { if (tg && tg.openLink) tg.openLink(url); else window.open(url, '_blank'); }
// Нажатие на ссылку внутри карточки открывает сайт, а не саму заметку
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-link]');
  if (a) { e.preventDefault(); e.stopPropagation(); openExternal(a.href); }
}, true);

function noteCards(notes) {
  return notes.map((n) => `<div class="note" data-note="${n.id}">
      <div class="note-text">${linkify(esc(n.text))}</div>
      <div class="meta">${esc(n.folder ?? '')} · ${esc(fmtDate(n.created_at))}${n.reminder ? ` · <span class="badge">⏰ ${esc(n.reminder.when)}${n.reminder.repeat ? ' 🔁' : ''}</span>` : ''}</div></div>`).join('');
}

// ---------- папка ----------
async function screenFolder(id, name, kind = null) {
  const protectedFolder = !!kind;
  h(`${subHeader(name)}<div class="card"><input id="fsearch" type="search" placeholder="Поиск в папке" autocomplete="off">
     ${protectedFolder ? '' : '<div class="btnrow"><button class="ghost mini" id="ren">Переименовать</button><button class="ghost mini danger" id="del">Удалить папку</button></div>'}</div>
     <div id="list"><p class="muted">Загрузка…</p></div>`);
  bindBack();
  let q = '';
  const load = async () => {
    const r = await api(`/api/notes?folder=${id}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const notes = r.data.notes;
    if (kind === 'tasks') return drawTasks(notes);
    $('list').innerHTML = noteCards(notes) || `<p class="muted">${q ? 'Ничего не найдено.' : kind === 'inbox' ? 'Здесь пока пусто. Пришлите боту ссылку, и она появится тут.' : 'В этой папке пока пусто.'}</p>`;
  };
  // Задачи: невыполненные сверху, серая полоса «Выполненные», ниже выполненные (зачёркнутые и бледные)
  const drawTasks = (notes) => {
    const open = notes.filter((n) => !n.done);
    const done = notes.filter((n) => n.done).sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    const row = (n) => `<div class="task ${n.done ? 'done' : ''}" data-note="${n.id}">
        <button class="box" data-toggle="${n.id}" aria-label="Отметить">${n.done ? '✓' : ''}</button>
        <div class="tbody"><div class="ttext">${linkify(esc(n.text))}</div>
          ${n.reminder ? `<div class="meta"><span class="badge">⏰ ${esc(n.reminder.when)}${n.reminder.repeat ? ' 🔁' : ''}</span></div>` : ''}</div>
        <button class="x" data-del="${n.id}" aria-label="Удалить">✕</button></div>`;
    $('list').innerHTML = (open.map(row).join('') || `<p class="muted">${q ? 'Ничего не найдено.' : 'Невыполненных задач нет.'}</p>`)
      + (done.length ? `<div class="donebar">Выполненные · ${done.length}</div>${done.map(row).join('')}` : '');
  };
  load();
  let timer;
  $('fsearch').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { q = e.target.value.trim(); load(); }, 300); };
  $('list').onclick = async (e) => {
    const tg1 = e.target.closest('[data-toggle]');
    if (tg1) { await api('/api/notes/toggle', { id: Number(tg1.dataset.toggle) }); haptic1(); return load(); }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmBox('Удалить задачу? Она уйдёт в корзину на 7 дней.'))) return;
      const r = await api('/api/notes/delete', { id: Number(del.dataset.del) });
      return r.ok ? load() : notify(errText(r.data.error));
    }
    const c = e.target.closest('[data-note]');
    if (c) show(() => screenNote(Number(c.dataset.note)));
  };
  if ($('ren')) $('ren').onclick = async () => {
    const nn = await askText('Новое название', name);
    if (!nn || nn === name) return;
    const r = await api('/api/folders/rename', { id, name: nn });
    if (r.ok) { current = () => screenFolder(id, nn, kind); current(); } else notify(errText(r.data.error));
  };
  if ($('del')) $('del').onclick = async () => {
    if (!(await confirmBox(`Удалить папку «${name}»? Она вместе со всеми заметками уйдёт в корзину на 7 дней.`))) return;
    const r = await api('/api/folders/delete', { id });
    if (r.ok) back(); else notify(errText(r.data.error));
  };
}

// ---------- заметка ----------
async function screenNote(id) {
  h(`${subHeader('Заметка')}<p class="muted">Загрузка…</p>`);
  bindBack();
  const [nr, ov] = await Promise.all([api('/api/note?id=' + id), api('/api/overview')]);
  if (!nr.ok) { h(`${subHeader('Заметка')}<div class="card"><p>Заметка не найдена.</p></div>`); return bindBack(); }
  const { note, reminder } = nr.data;
  const folders = ov.data.folders;
  h(`${subHeader('Заметка')}
    <section class="card">
      <textarea id="ntext" maxlength="2000" rows="5">${esc(note.text)}</textarea>
      <select id="nfolder">${folders.map((f) => `<option value="${f.id}" ${f.id === note.folder_id ? 'selected' : ''}>📁 ${esc(f.name)}</option>`).join('')}<option value="__new__">+ Новая папка…</option></select>
      ${(note.text.match(/https?:\/\/[^\s<>"]+/g) || []).map((u) => u.replace(/[.,;:!?)»\]]+$/, '')).filter((u, i, a) => a.indexOf(u) === i).map((u) => `<button type="button" class="ghost linkbtn" data-open="${esc(u)}">🔗 ${esc(u.length > 40 ? u.slice(0, 40) + '…' : u)}</button>`).join('')}
      <p class="muted small">Создана: ${esc(fmtDate(note.created_at))}</p>
      <button id="save" disabled>Сохранить</button>
    </section>
    <section class="card"><h2>Напоминание</h2>
      ${reminder ? `<p>⏰ <b>${esc(reminder.when)}</b>${reminder.repeat ? `<br><span class="muted">🔁 ${esc(reminder.repeat.text)}</span>` : ''}</p>
        <div class="btnrow"><button class="ghost mini" id="remEdit">Изменить</button><button class="ghost mini danger" id="remOff">Убрать</button></div>
        <div class="btnrow"><button class="ghost mini" id="ics">В календарь (.ics)</button><button class="ghost mini" id="gcal">В Google Календарь</button></div>`
      : '<p class="muted">Не задано.</p><button class="ghost" id="remEdit">Добавить напоминание</button>'}
    </section>
    <button class="ghost danger wide" id="delNote">Удалить заметку</button>`);
  bindBack();
  document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openExternal(b.dataset.open); });
  const dirty = () => { $('save').disabled = $('ntext').value.trim() === note.text && Number($('nfolder').value) === note.folder_id; };
  $('ntext').oninput = dirty;
  $('nfolder').onchange = async () => {
    const sel = $('nfolder');
    if (sel.value !== '__new__') return dirty();
    // Новая папка прямо при переносе: если такая уже есть, заметка просто переедет в неё
    const revert = () => { sel.value = String(note.folder_id); dirty(); };
    const name = await askText('Название новой папки');
    if (!name) return revert();
    const r = await api('/api/folders/create', { name });
    let id = r.ok ? r.data.id : null;
    if (!r.ok && r.data.error === 'exists') {
      const o = await api('/api/overview');
      const f = o.ok && o.data.folders.find((x) => x.name.toLowerCase() === name.toLowerCase());
      id = f ? f.id : null;
    }
    if (!id) { notify(errText(r.data.error)); return revert(); }
    if (![...sel.options].some((o) => o.value === String(id))) {
      const opt = document.createElement('option');
      opt.value = String(id); opt.textContent = `📁 ${name}`;
      sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
    }
    sel.value = String(id);
    dirty();
  };
  $('save').onclick = async () => {
    $('save').disabled = true;
    const r = await api('/api/notes/update', { id, text: $('ntext').value, folder_id: Number($('nfolder').value) });
    if (r.ok) { toast('Сохранено'); haptic(); screenNote(id); } else { notify(errText(r.data.error)); dirty(); }
  };
  $('delNote').onclick = async () => {
    if (!(await confirmBox('Удалить заметку? Она уйдёт в корзину на 7 дней.'))) return;
    const r = await api('/api/notes/delete', { id });
    if (r.ok) back(); else notify(errText(r.data.error));
  };
  if ($('remEdit')) $('remEdit').onclick = () => show(() => screenReminder(id, reminder));
  if ($('remOff')) $('remOff').onclick = async () => {
    const r = await api('/api/reminders/cancel', { note_id: id });
    if (r.ok) screenNote(id);
  };
  const openLink = (u) => { if (tg && tg.openLink) tg.openLink(u); else window.open(u, '_blank'); };
  const calendarLink = async (kind) => {
    const r = await api('/api/ics-link?note_id=' + id);
    if (r.ok) openLink(r.data[kind]); else notify('Не удалось подготовить ссылку.');
  };
  if ($('ics')) $('ics').onclick = () => calendarLink('ics');
  if ($('gcal')) $('gcal').onclick = () => calendarLink('google');
}

// ---------- напоминание: время и повтор ----------
function screenReminder(noteId, existing) {
  const pad = (n) => String(n).padStart(2, '0');
  const soon = new Date(Date.now() + 3600e3);
  const dflt = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00`;
  const rep = existing && existing.repeat;
  const days = new Set(rep ? rep.weekdays : []);
  h(`${subHeader('Напоминание')}
    <section class="card">
      <h3>Когда</h3>
      <input id="when" type="datetime-local" value="${esc(existing ? existing.local : dflt)}">
      <p class="muted small">Время по вашему часовому поясу: ${esc(me.tz)}</p>
      <label class="check"><input type="checkbox" id="repeat" ${rep ? 'checked' : ''}> Повторять</label>
      <div id="repbox" ${rep ? '' : 'hidden'}>
        <h3>По дням недели</h3>
        <div class="chips" id="days">${WD.map((d, i) => `<button type="button" data-d="${i + 1}" class="chip ${days.has(i + 1) ? 'on' : ''}">${d}</button>`).join('')}</div>
        <h3>Как часто</h3>
        <select id="every">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${rep && rep.interval_weeks === n ? 'selected' : ''}>${n === 1 ? 'Каждую неделю' : `Раз в ${n} недели`}</option>`).join('')}</select>
      </div>
      <p id="err" class="err" hidden></p>
      <button id="saveRem">Сохранить</button>
    </section>`);
  bindBack();
  $('repeat').onchange = () => { $('repbox').hidden = !$('repeat').checked; };
  $('days').onclick = (e) => { const b = e.target.closest('button'); if (b) { b.classList.toggle('on'); haptic1(); } };
  $('saveRem').onclick = async () => {
    const err = $('err'); err.hidden = true;
    const body = { note_id: noteId, local: $('when').value };
    if (!body.local) { err.textContent = 'Выберите дату и время.'; err.hidden = false; return; }
    if ($('repeat').checked) {
      const wd = [...document.querySelectorAll('#days .chip.on')].map((b) => Number(b.dataset.d));
      if (!wd.length) { err.textContent = 'Отметьте хотя бы один день недели.'; err.hidden = false; return; }
      body.repeat = { weekdays: wd, interval_weeks: Number($('every').value) };
    }
    $('saveRem').disabled = true;
    const r = await api('/api/reminders/set', body);
    $('saveRem').disabled = false;
    if (r.ok) { haptic(); back(); } else { err.textContent = errText(r.data.error); err.hidden = false; }
  };
}
const haptic1 = () => { try { tg.HapticFeedback.selectionChanged(); } catch {} };

// ---------- вкладка «Покупки»: списки по магазинам ----------
let shopKey = 'all'; // выбранный список: 'all', 'none' или номер; запоминается между переключениями вкладок
async function screenShopping() {
  frame('shop', `<div class="card"><h2>🛒 Покупки</h2>
      <div class="chips scroll" id="lists"></div>
      <div id="listActions"></div>
      <div class="addrow"><input id="item" maxlength="60" placeholder="Что купить?" autocomplete="off"><button id="add" class="addbtn">+</button></div>
      <div id="items"><p class="muted">Загрузка…</p></div></div>`);
  let data = { lists: [], none: { open: 0, done: 0 }, items: [] };
  const curList = () => data.lists.find((l) => String(l.id) === String(shopKey));

  const draw = () => {
    if (shopKey !== 'all' && shopKey !== 'none' && !curList()) shopKey = 'all'; // список удалили
    const total = data.none.open + data.lists.reduce((a, l) => a + l.open, 0);
    const chip = (k, label, n) => `<button class="chip ${String(k) === String(shopKey) ? 'on' : ''}" data-key="${k}">${esc(label)}${n ? ` <b>${n}</b>` : ''}</button>`;
    $('lists').innerHTML = chip('all', 'Все', total) + data.lists.map((l) => chip(l.id, l.name, l.open)).join('') + chip('none', 'Без магазина', data.none.open)
      + '<button class="chip add" id="newList" aria-label="Добавить магазин">+ Магазин</button>';
    $('listActions').innerHTML = curList()
      ? `<div class="btnrow">${curList().custom ? '<button class="ghost mini" id="renList">Переименовать</button>' : ''}<button class="ghost mini danger" id="delList">Убрать магазин</button></div>` : '';

    const open = data.items.filter((i) => !i.done), done = data.items.filter((i) => i.done);
    const row = (i) => `<div class="shop ${i.done ? 'done' : ''}" data-id="${i.id}"><span class="box">${i.done ? '✓' : ''}</span><span class="name">${esc(i.name)}</span>
        <button class="x" data-move="${i.id}" aria-label="В другой список">⇄</button><button class="x" data-del="${i.id}" aria-label="Убрать">✕</button></div>`;
    let html;
    if (shopKey === 'all') {
      // Цельный список, сгруппированный по магазинам: внутри группы сначала нужное, потом купленное (бледнее)
      const groups = [];
      for (const i of data.items) {
        const name = i.list_name ?? 'Без магазина';
        let g = groups.find((x) => x.name === name);
        if (!g) { g = { name, items: [] }; groups.push(g); }
        g.items.push(i);
      }
      html = groups.map((g) => `<div class="sep">${esc(g.name)}</div>${g.items.map(row).join('')}`).join('') || '<p class="muted">Список пуст.</p>';
      if (done.length) html += `<button class="ghost wide" id="clear">Очистить купленное (${done.length})</button>`;
    } else {
      html = (open.map(row).join('') || '<p class="muted">Здесь всё куплено или пусто.</p>')
        + (done.length ? `<div class="sep">Куплено</div>${done.map(row).join('')}<button class="ghost wide" id="clear">Очистить купленное (${done.length})</button>` : '');
    }
    $('items').innerHTML = html;
  };

  const load = async () => { const r = await api(`/api/shopping?list=${shopKey}`); if (r.ok) { data = r.data; draw(); } };
  const act = async (path, body) => {
    const r = await api(path, { ...body, view: shopKey });
    if (r.ok) { data = r.data; draw(); } else notify(errText(r.data.error));
    return r;
  };
  await load();

  $('lists').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'newList') {
      const name = await pickStoreName(data.lists.map((l) => l.name));
      if (!name) return;
      // Магазин добавляется в избранные, его список появляется сам
      const r = await api('/api/shopping/lists/create', { name });
      if (r.ok) { shopKey = String(r.data.id); data = r.data; draw(); haptic(); } else notify(errText(r.data.error));
    } else if (b.dataset.key !== undefined) { shopKey = b.dataset.key; load(); }
  };
  $('listActions').onclick = async (e) => {
    const l = curList();
    if (!l) return;
    if (e.target.id === 'renList') {
      const name = await askText('Новое название', l.name);
      if (!name || name === l.name) return;
      const r = await api('/api/shopping/lists/rename', { id: l.id, name });
      if (r.ok) { data = r.data; draw(); } else notify(errText(r.data.error));
    } else if (e.target.id === 'delList') {
      if (l.open + l.done > 0) return notify(`В списке «${l.name}» ещё есть пункты (${l.open + l.done}). Сначала очистите список, потом можно убрать магазин.`);
      if (!(await confirmBox(`Убрать магазин «${l.name}»? Список пуст.`))) return;
      const r = await api('/api/shopping/lists/delete', { id: l.id });
      if (r.ok) { shopKey = 'all'; data = r.data; draw(); }
      else notify(r.data.error === 'not_empty' ? `В списке ещё есть пункты (${r.data.count}). Сначала очистите список.` : errText(r.data.error));
    }
  };
  $('items').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return act('/api/shopping/delete', { id: Number(del.dataset.del) });
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const choice = await pickList(data.lists, 'Перенести в…');
      if (choice === undefined) return;
      return act('/api/shopping/move', { id: Number(mv.dataset.move), list_id: choice });
    }
    if (e.target.id === 'clear') return act('/api/shopping/clear', {});
    const row = e.target.closest('.shop');
    if (!row) return;
    // Сразу меняем вид, затем подтверждаем на сервере
    const it = data.items.find((i) => i.id === Number(row.dataset.id));
    if (it) { it.done = it.done ? 0 : 1; draw(); haptic1(); }
    act('/api/shopping/toggle', { id: Number(row.dataset.id) });
  };
  const add = async () => {
    const name = $('item').value.trim();
    if (!name) return;
    $('item').value = '';
    // В выбранный список; в «Все» и «Без магазина» новый пункт идёт в «Без магазина»
    const listId = curList() ? curList().id : null;
    await act('/api/shopping/add', { name, list_id: listId });
  };
  $('add').onclick = add;
  $('item').onkeydown = (e) => { if (e.key === 'Enter') add(); };
}

// Добавление магазина: предлагаем те, что ещё не в избранном (из готового перечня), либо своё название
async function pickStoreName(existing) {
  const r = await api('/api/stores');
  const have = new Set(existing.map((n) => n.toLowerCase()));
  const rest = r.ok ? r.data.stores.filter((x) => !x.custom && !x.favorite && !have.has(x.name.toLowerCase())) : [];
  if (!rest.length) return askText('Название магазина');
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet scroll"><h3>Добавить магазин</h3>
      <button class="ghost wide" data-store="__other__">Другой магазин (своё название)…</button>
      ${rest.map((x) => `<button class="ghost wide" data-store="${esc(x.name)}">${esc(x.name)}</button>`).join('')}
      <button class="wide" data-store="__cancel__">Отмена</button></div>`;
    document.body.appendChild(m);
    m.onclick = async (e) => {
      const b = e.target.closest('[data-store]');
      if (!b && e.target !== m) return;
      m.remove();
      if (!b || b.dataset.store === '__cancel__') return resolve(null);
      if (b.dataset.store === '__other__') return resolve(await askText('Название магазина'));
      resolve(b.dataset.store);
    };
  });
}

// Окно выбора списка для переноса пункта: возвращает номер списка, null («Без магазина») или undefined (отмена)
function pickList(lists, title) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>${esc(title)}</h3>
      <button class="ghost wide" data-pick="none">Без магазина</button>
      ${lists.map((l) => `<button class="ghost wide" data-pick="${l.id}">${esc(l.name)}</button>`).join('')}
      <button class="wide" data-pick="cancel">Отмена</button></div>`;
    document.body.appendChild(m);
    m.onclick = (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b && e.target !== m) return;
      m.remove();
      if (!b || b.dataset.pick === 'cancel') return resolve(undefined);
      resolve(b.dataset.pick === 'none' ? null : Number(b.dataset.pick));
    };
  });
}

// ---------- вкладка «Календарь» ----------
let calMonth = null;     // {y, m} показанный месяц
let calDay = null;       // выбранная дата YYYY-MM-DD
async function screenCalendar() {
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: me.tz }));
  if (!calMonth) calMonth = { y: nowLocal.getFullYear(), m: nowLocal.getMonth() + 1 };
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${nowLocal.getFullYear()}-${pad(nowLocal.getMonth() + 1)}-${pad(nowLocal.getDate())}`;
  if (!calDay) calDay = today;
  frame('cal', `<div class="card"><div class="calhead"><button class="ghost mini" id="prev">←</button><b id="mtitle"></b><button class="ghost mini" id="next">→</button></div>
      <div class="cal" id="grid"></div></div><div class="card" id="dayList"></div>`);
  const draw = (days) => {
    $('mtitle').textContent = `${MONTHS_NOM[calMonth.m - 1]} ${calMonth.y}`;
    const first = new Date(calMonth.y, calMonth.m - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const total = new Date(calMonth.y, calMonth.m, 0).getDate();
    let html = WD.map((d) => `<span class="wd">${d}</span>`).join('') + '<span></span>'.repeat(offset);
    for (let d = 1; d <= total; d++) {
      const key = `${calMonth.y}-${pad(calMonth.m)}-${pad(d)}`;
      html += `<button class="day ${key === today ? 'today' : ''} ${key === calDay ? 'sel' : ''}" data-day="${key}">${d}${days[key] ? '<i></i>' : ''}</button>`;
    }
    $('grid').innerHTML = html;
    const [y, m, d] = calDay.split('-').map(Number);
    const list = days[calDay] || [];
    $('dayList').innerHTML = `<h3>${d} ${MONTHS[m - 1]}</h3>` + (list.length
      ? list.map((x) => `<div class="note" data-note="${x.note_id}"><div class="note-text">${esc(x.time)} ${x.recurring ? '🔁 ' : ''}${esc(x.text)}</div></div>`).join('')
      : '<p class="muted">В этот день напоминаний нет.</p>');
  };
  const load = async () => {
    const r = await api(`/api/calendar?month=${calMonth.y}-${pad(calMonth.m)}`);
    draw(r.ok ? r.data.days : {});
    return r.ok ? r.data.days : {};
  };
  await load();
  $('prev').onclick = () => { calMonth = calMonth.m === 1 ? { y: calMonth.y - 1, m: 12 } : { y: calMonth.y, m: calMonth.m - 1 }; calDay = `${calMonth.y}-${pad(calMonth.m)}-01`; screenCalendar(); };
  $('next').onclick = () => { calMonth = calMonth.m === 12 ? { y: calMonth.y + 1, m: 1 } : { y: calMonth.y, m: calMonth.m + 1 }; calDay = `${calMonth.y}-${pad(calMonth.m)}-01`; screenCalendar(); };
  app.onclick = async (e) => {
    const day = e.target.closest('[data-day]');
    if (day) { calDay = day.dataset.day; return screenCalendar(); }
    const n = e.target.closest('[data-note]');
    if (n) show(() => screenNote(Number(n.dataset.note)));
  };
}

const screenMain = () => tab(screenNotes);

// ---------- настройки ----------
function screenSettings() {
  app.onclick = null;
  const themes = [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  h(`${subHeader('Настройки')}<section class="card">
      <h3 class="first">Тема</h3>
      <div class="seg" id="themes">${themes.map(([v, t]) =>
        `<button data-v="${v}" class="${me.theme === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <p class="muted small">«Авто» следует за темой Telegram.</p>
      <h3>Часовой пояс</h3>
      <p>${esc(me.tz)}${me.tz !== browserTz ? `<br><span class="muted">Устройство сообщает: ${esc(browserTz)}</span>` : ''}</p>
      ${me.tz !== browserTz ? '<button id="tzfix" class="ghost">Взять с устройства</button>' : ''}
      <h3>Инструменты</h3>
      <button class="ghost wide" id="storesBtn">🏪 Магазины</button>
      <button class="ghost wide" id="pwBtn">🔑 Генератор паролей</button>
      <h3>Бот</h3>
      <p id="botstate">${me.can_write ? '✅ Бот подключён и может писать вам.' : 'Разрешите боту писать вам, чтобы он присылал напоминания и принимал заметки.'}</p>
      ${me.can_write ? '' : '<button id="connect">Подключить бота</button>'}
      <p id="err" class="err" hidden></p>
    </section>`);

  bindBack();
  $('pwBtn').onclick = () => show(screenPasswords);
  $('storesBtn').onclick = () => show(screenStores);
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

// ---------- магазины ----------
async function screenStores() {
  h(`${subHeader('Магазины')}<p class="muted">Загрузка…</p>`);
  bindBack();
  const r = await api('/api/stores');
  if (!r.ok) { h(`${subHeader('Магазины')}<div class="card"><p>Не удалось загрузить.</p></div>`); return bindBack(); }
  let stores = r.data.stores;
  let q = '';
  h(`${subHeader('Магазины')}
    <section class="card">
      <p class="muted small">Отметьте звёздочкой магазины, где вы покупаете: у каждого появится свой список на вкладке «Покупки». Бот узнаёт их названия, как бы вы их ни произнесли («Костко», «Костка» всё равно Costco). Новый магазин, который вы назовёте боту, добавится сюда сам. Убрать магазин можно, когда его список пуст.</p>
      <input id="sq" type="search" placeholder="Найти магазин" autocomplete="off">
      <div id="slist"></div>
      <button class="ghost wide" id="addStore">+ Свой магазин</button>
    </section>`);
  bindBack();
  const draw = () => {
    const f = q.toLowerCase();
    const shown = stores.filter((x) => !f || x.name.toLowerCase().includes(f) || x.aliases.some((a) => a.toLowerCase().includes(f)));
    const groups = [];
    const fav = shown.filter((x) => x.favorite);
    if (fav.length) groups.push(['Избранные', fav]);
    for (const g of ['Продукты и универмаги', 'Хозяйственные', 'Свои']) {
      const items = shown.filter((x) => !x.favorite && x.group === g);
      if (items.length) groups.push([g, items]);
    }
    $('slist').innerHTML = groups.map(([g, items]) => `<div class="sep">${esc(g)}</div>${items.map((x) => `<div class="srow">
        <button class="star ${x.favorite ? 'on' : ''}" data-fav="${esc(x.name)}" aria-label="В избранное">${x.favorite ? '★' : '☆'}</button>
        <div class="sname"><div>${esc(x.name)}${x.items ? ` <span class="tag">в списке: ${x.items}</span>` : ''}</div>
          ${x.aliases.length ? `<div class="meta">${esc(x.aliases.slice(0, 4).join(', '))}</div>` : ''}</div>
        ${x.custom ? `<button class="x" data-del="${x.id}" aria-label="Убрать">✕</button>` : ''}</div>`).join('')}`).join('') || '<p class="muted">Ничего не найдено.</p>';
  };
  draw();
  $('sq').oninput = (e) => { q = e.target.value.trim(); draw(); };
  $('slist').onclick = async (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      const st = stores.find((x) => x.name === star.dataset.fav);
      const r2 = await api('/api/stores/favorite', { name: st.name, favorite: !st.favorite });
      if (r2.ok) { stores = r2.data.stores; draw(); haptic1(); }
      else if (r2.data.error === 'not_empty') notify(`В списке «${r2.data.name}» ещё есть пункты (${r2.data.count}). Сначала очистите список, потом можно убрать магазин.`);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmBox('Убрать этот магазин и его пустой список?'))) return;
      const r2 = await api('/api/stores/delete', { id: Number(del.dataset.del) });
      if (r2.ok) { stores = r2.data.stores; draw(); }
      else if (r2.data.error === 'not_empty') notify(`В списке «${r2.data.name}» ещё есть пункты (${r2.data.count}). Сначала очистите список.`);
    }
  };
  $('addStore').onclick = async () => {
    const name = await askText('Название магазина');
    if (!name) return;
    const r2 = await api('/api/stores/add', { name });
    if (!r2.ok) return notify(errText(r2.data.error));
    stores = r2.data.stores; draw();
    toast(r2.data.existing ? `Это «${r2.data.existing}», отметил избранным` : 'Магазин добавлен');
  };
}

// ---------- корзина ----------
const daysLeft = (iso) => {
  const d = Math.ceil((new Date(iso) - Date.now()) / 86400e3);
  return d <= 0 ? 'удалится сегодня' : `ещё ${d} дн.`;
};
const keepText = (iso) => {
  const d = Math.ceil((new Date(iso) - Date.now()) / 86400e3);
  return d <= 0 ? 'Удалится сегодня.' : `Хранится ещё ${d} дн.`;
};
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };

async function trashRestore(type, id) {
  const r = await api('/api/trash/restore', { type, id });
  if (!r.ok) { notify('Это уже нельзя вернуть.'); return false; }
  haptic();
  if (type === 'folder') toast(r.data.merged ? `Добавил ${r.data.count} в папку «${r.data.name}»` : `Вернул папку «${r.data.name}»`);
  else if (type === 'list') toast(r.data.merged ? `Добавил ${r.data.count} в список «${r.data.name}»` : `Вернул список «${r.data.name}»`);
  else if (type === 'note') toast(`Вернул в «${r.data.folder}»`);
  else toast('Вернул');
  return true;
}
async function trashPurge(type, id, what) {
  if (!(await confirmBox(`Удалить ${what} навсегда? Вернуть будет нельзя.`))) return false;
  const r = await api('/api/trash/purge', { type, id });
  if (!r.ok) { notify('Не получилось.'); return false; }
  return true;
}

async function screenTrash() {
  h(`${subHeader('Корзина')}<p class="muted">Загрузка…</p>`);
  bindBack();
  const r = await api('/api/trash');
  if (!r.ok) { h(`${subHeader('Корзина')}<div class="card"><p>Не удалось загрузить.</p></div>`); return bindBack(); }
  const t = r.data;
  const total = t.folders.length + t.notes.length + t.lists.length + t.items.length;
  const acts = (type, id) => `<div class="acts"><button class="mini" data-restore="${type}:${id}">Вернуть</button><button class="mini danger" data-purge="${type}:${id}">Навсегда</button></div>`;
  const row = (type, id, title, meta, openAttr = '') => `<div class="trow"><div class="tinfo" ${openAttr}><div class="ttitle">${title}</div><div class="meta">${meta}</div></div>${acts(type, id)}</div>`;
  const sec = (name, rows) => (rows.length ? `<div class="sep">${name}</div>${rows.join('')}` : '');
  h(`${subHeader('Корзина')}
    <section class="card"><p class="muted small">Удалённое хранится ${t.days} дней, потом стирается окончательно.</p>
      ${total ? '' : '<p>Корзина пуста.</p>'}
      ${sec('Папки', t.folders.map((f) => row('folder', f.id, `📁 ${esc(f.name)}`, `${f.n} ${plural(f.n, 'заметка', 'заметки', 'заметок')} · ${daysLeft(f.expires_at)}`, `data-open-folder="${f.id}"`)))}
      ${sec('Заметки', t.notes.map((n) => row('note', n.id, esc(n.text.length > 90 ? n.text.slice(0, 90) + '…' : n.text), `${esc(n.folder ?? '')} · ${daysLeft(n.expires_at)}`, `data-open-note="${n.id}"`)))}
      ${sec('Списки покупок', t.lists.map((l) => row('list', l.id, `🛒 ${esc(l.name)}`, `${l.n} ${plural(l.n, 'пункт', 'пункта', 'пунктов')} · ${daysLeft(l.expires_at)}`)))}
      ${sec('Пункты покупок', t.items.map((i) => row('item', i.id, esc(i.name), `${esc(i.list ?? 'Без магазина')} · ${daysLeft(i.expires_at)}`)))}
      ${total ? '<button class="ghost danger wide" id="emptyTrash">Очистить корзину</button>' : ''}
    </section>`);
  bindBack();
  const names = { folder: 'папку', note: 'заметку', list: 'список', item: 'пункт' };
  app.onclick = async (e) => {
    const open = e.target.closest('[data-open-folder],[data-open-note]');
    if (open && !e.target.closest('button')) {
      if (open.dataset.openFolder) return show(() => screenTrashFolder(Number(open.dataset.openFolder)));
      return show(() => screenTrashNote(Number(open.dataset.openNote)));
    }
    const rb = e.target.closest('[data-restore]'), pb = e.target.closest('[data-purge]');
    if (rb) { const [type, id] = rb.dataset.restore.split(':'); if (await trashRestore(type, Number(id))) screenTrash(); }
    else if (pb) { const [type, id] = pb.dataset.purge.split(':'); if (await trashPurge(type, Number(id), names[type])) screenTrash(); }
    else if (e.target.id === 'emptyTrash') {
      if (!(await confirmBox('Очистить корзину? Всё в ней удалится навсегда.'))) return;
      await api('/api/trash/empty', {}); screenTrash();
    }
  };
}

// Удалённая папка: можно войти, посмотреть заметки, вернуть всю папку или одну заметку (она вернётся в «Разное»)
async function screenTrashFolder(id) {
  h(`${subHeader('Папка в корзине')}<p class="muted">Загрузка…</p>`);
  bindBack();
  const r = await api('/api/trash/folder?id=' + id);
  if (!r.ok) { h(`${subHeader('Папка в корзине')}<div class="card"><p>Папки уже нет в корзине.</p></div>`); return bindBack(); }
  const { folder, notes } = r.data;
  h(`${subHeader('Папка в корзине')}
    <section class="card"><h2>📁 ${esc(folder.name)}</h2>
      <p class="muted small">${notes.length} ${plural(notes.length, 'заметка', 'заметки', 'заметок')}. ${keepText(folder.expires_at)} Папку можно вернуть целиком или открыть заметку и вернуть только её (она попадёт в «Разное»).</p>
      <div class="btnrow"><button class="mini" id="restoreFolder">Вернуть папку</button><button class="ghost mini danger" id="purgeFolder">Удалить навсегда</button></div></section>
    <div id="tlist">${notes.map((n) => `<div class="note" data-tnote="${n.id}"><div class="note-text">${linkify(esc(n.text))}</div></div>`).join('') || '<p class="muted">В папке нет заметок.</p>'}</div>`);
  bindBack();
  $('restoreFolder').onclick = async () => { if (await trashRestore('folder', id)) { back(); } };
  $('purgeFolder').onclick = async () => { if (await trashPurge('folder', id, 'папку со всем содержимым')) back(); };
  $('tlist').onclick = (e) => { const c = e.target.closest('[data-tnote]'); if (c) show(() => screenTrashNote(Number(c.dataset.tnote))); };
}

// Заметка из корзины: просмотр как у обычной, но без правки; кнопки «Вернуть» и «Удалить навсегда»
async function screenTrashNote(id) {
  h(`${subHeader('Заметка в корзине')}<p class="muted">Загрузка…</p>`);
  bindBack();
  const r = await api('/api/trash/note?id=' + id);
  if (!r.ok) { h(`${subHeader('Заметка в корзине')}<div class="card"><p>Заметки уже нет в корзине.</p></div>`); return bindBack(); }
  const n = r.data.note;
  h(`${subHeader('Заметка в корзине')}
    <section class="card"><div class="tview">${linkify(esc(n.text))}</div>
      <p class="muted small">${n.deleted_with_folder ? 'Из удалённой папки: вернётся в «Разное».' : `Была в папке «${esc(n.folder ?? 'Разное')}».`} ${keepText(n.expires_at)}</p>
      <div class="btnrow"><button class="mini" id="restoreNote">Вернуть</button><button class="ghost mini danger" id="purgeNote">Удалить навсегда</button></div></section>`);
  bindBack();
  $('restoreNote').onclick = async () => { if (await trashRestore('note', id)) back(); };
  $('purgeNote').onclick = async () => { if (await trashPurge('note', id, 'заметку')) back(); };
}

// ---------- генератор паролей ----------
// Пароль создаётся здесь же, на устройстве, и никуда не отправляется. Случайность: crypto.getRandomValues.
const PW_SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}:;,.?/',
};
const PW_MIN = 8, PW_MAX = 120;

function screenPasswords() {
  h(`${subHeader('Генератор паролей')}
    <section class="card pg-out">
      <div id="pgPw" class="pg-pw" tabindex="0" aria-live="polite"></div>
      <div class="pg-legend" aria-hidden="true"><span>буквы</span><span class="pg-d">цифры</span><span class="pg-s">знаки</span></div>
      <div class="pg-meter">
        <div id="pgBars" class="pg-bars" data-level="0"><i></i><i></i><i></i><i></i></div>
        <div class="pg-mtext"><span>Надёжность: <b id="pgStrength">—</b></span><span id="pgEntropy">—</span></div>
      </div>
      <div class="pg-actions"><button id="pgCopy" type="button">Копировать</button><button id="pgNew" class="ghost" type="button" aria-label="Сгенерировать новый пароль">Новый</button></div>
    </section>
    <section class="card pg-opts">
      <div class="pg-lenrow">
        <div class="pg-lenhead"><label for="pgLenN">Длина пароля</label>
          <input id="pgLenN" class="pg-num" type="number" min="${PW_MIN}" max="${PW_MAX}" step="1" value="16" inputmode="numeric"></div>
        <input id="pgLen" type="range" min="${PW_MIN}" max="${PW_MAX}" step="1" value="16">
        <div class="pg-ends"><span>${PW_MIN}</span><span>${PW_MAX}</span></div>
      </div>
      <label class="pg-row"><input id="pgLower" type="checkbox" checked><div class="pg-t">Строчные буквы</div><div class="pg-eg">abc</div></label>
      <label class="pg-row"><input id="pgUpper" type="checkbox" checked><div class="pg-t">Заглавные буквы</div><div class="pg-eg">ABC</div></label>
      <label class="pg-row"><input id="pgDigits" type="checkbox" checked><div class="pg-t">Цифры</div><div class="pg-eg">0–9</div></label>
      <label class="pg-row"><input id="pgSymbols" type="checkbox" checked><div class="pg-t">Специальные знаки</div><div class="pg-eg">!@#$%</div></label>
      <label class="pg-row"><input id="pgNoRep" type="checkbox" checked><div class="pg-t">Без одинаковых символов подряд<span>Никаких «aa», «11», «!!»</span></div></label>
    </section>
    <p id="pgNote" class="err small" role="status"></p>
    <p class="muted small">Пароль создаётся на вашем устройстве и никуда не отправляется.</p>`);
  bindBack();

  const pwEl = $('pgPw'), copyBtn = $('pgCopy'), lenR = $('pgLen'), lenN = $('pgLenN'), noRepeat = $('pgNoRep');
  const opts = { lower: $('pgLower'), upper: $('pgUpper'), digits: $('pgDigits'), symbols: $('pgSymbols') };
  let current = '', copyTimer = null;

  // Равномерное случайное число от 0 до max-1 без смещения (отбрасываем «лишние» значения)
  const randInt = (max) => {
    const limit = Math.floor(4294967296 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  };
  const clampLen = (v) => { v = Math.round(Number(v)); if (!isFinite(v)) v = 16; return Math.min(PW_MAX, Math.max(PW_MIN, v)); };
  const activeKeys = () => Object.keys(opts).filter((k) => opts[k].checked);
  const hasClass = (str, set) => [...str].some((c) => set.includes(c));

  function generate(len, keys, avoidRepeat) {
    const pool = keys.map((k) => PW_SETS[k]).join('');
    let out = '';
    for (let attempt = 0; attempt < 5000; attempt++) {
      const chars = [];
      let prev = '';
      for (let i = 0; i < len; i++) {
        let c;
        do { c = pool[randInt(pool.length)]; } while (avoidRepeat && c === prev);
        chars.push(c); prev = c;
      }
      out = chars.join('');
      if (keys.every((k) => hasClass(out, PW_SETS[k]))) break; // в пароле есть символы каждого выбранного набора
    }
    return { text: out, poolSize: pool.length };
  }

  function renderPw(text) {
    pwEl.textContent = '';
    for (const ch of text) {
      const span = document.createElement('span');
      if (PW_SETS.digits.includes(ch)) span.className = 'pg-d';
      else if (PW_SETS.symbols.includes(ch)) span.className = 'pg-s';
      span.textContent = ch;
      pwEl.appendChild(span);
    }
    pwEl.classList.toggle('long', text.length > 40);
  }

  function updateMeter(len, poolSize, avoidRepeat) {
    const bits = avoidRepeat ? Math.log2(poolSize) + (len - 1) * Math.log2(poolSize - 1) : len * Math.log2(poolSize);
    let level, label;
    if (bits < 50) { level = 1; label = 'слабый'; }
    else if (bits < 70) { level = 2; label = 'средний'; }
    else if (bits < 100) { level = 3; label = 'хороший'; }
    else { level = 4; label = 'отличный'; }
    $('pgBars').setAttribute('data-level', String(level));
    $('pgStrength').textContent = label;
    $('pgEntropy').textContent = `≈ ${Math.round(bits)} бит · ${len} симв.`;
  }

  const resetCopy = () => { clearTimeout(copyTimer); copyBtn.textContent = 'Копировать'; copyBtn.classList.remove('copied'); };
  function markCopied(msg) {
    copyBtn.textContent = msg; copyBtn.classList.add('copied');
    clearTimeout(copyTimer); copyTimer = setTimeout(resetCopy, 1800);
  }
  function fallbackCopy() {
    try {
      const range = document.createRange(); range.selectNodeContents(pwEl);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand && document.execCommand('copy');
      markCopied(ok ? 'Скопировано' : 'Выделено, нажмите «Копировать»');
    } catch { markCopied('Выделено, нажмите «Копировать»'); }
  }

  function run() {
    const keys = activeKeys();
    const len = clampLen(lenR.value);
    const res = generate(len, keys, noRepeat.checked);
    current = res.text;
    renderPw(current);
    updateMeter(len, res.poolSize, noRepeat.checked);
    resetCopy();
  }

  copyBtn.onclick = () => {
    if (!current) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(current).then(() => { markCopied('Скопировано'); haptic1(); }, fallbackCopy);
    else fallbackCopy();
  };
  $('pgNew').onclick = run;
  lenR.oninput = () => { lenN.value = lenR.value; run(); };
  lenN.oninput = () => {
    const raw = Number(lenN.value);
    if (lenN.value !== '' && raw >= PW_MIN && raw <= PW_MAX) { lenR.value = Math.round(raw); run(); }
  };
  lenN.onchange = () => { const v = clampLen(lenN.value); lenN.value = v; lenR.value = v; run(); };
  Object.keys(opts).forEach((k) => {
    opts[k].onchange = () => {
      if (activeKeys().length === 0) { opts[k].checked = true; $('pgNote').textContent = 'Нужен хотя бы один набор символов.'; return; }
      $('pgNote').textContent = '';
      run();
    };
  });
  noRepeat.onchange = run;
  run();
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

  h(`${subHeader('Люди')}<section class="card">
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

  bindBack();
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
      b.disabled = false; notify('Не получилось.');
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
      if (!rr.ok) return notify('Не получилось.');
      $('linkbox').hidden = false;
      $('linktext').textContent = rr.data.link;
      $('sharenew').onclick = () => share(rr.data.link);
      try { await navigator.clipboard.writeText(rr.data.link); } catch {}
    }
  };
}

// ---------- запуск ----------
(async () => {
  if (tg) {
    tg.ready(); tg.expand();
    // Полный экран на телефоне (Bot API 8.0+): без выдвижной шапки Telegram. На компьютере не включаем, чтобы окно не разворачивалось.
    try {
      const mobile = tg.platform === 'ios' || tg.platform === 'android';
      if (mobile && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen && !tg.isFullscreen) tg.requestFullscreen();
    } catch {}
  }
  if (!initData) return screenMessage('Блокнот', 'Откройте приложение через Telegram: по ссылке-приглашению или кнопкой «Блокнот» в чате с ботом.');
  const r = await api('/api/me?code=' + encodeURIComponent(startParam));
  if (r.status === 403 && r.data.error === 'blocked') return screenMessage('Блокнот', 'Доступ закрыт.');
  if (!r.ok) return screenMessage('Блокнот', 'Не удалось войти. Откройте приложение заново из Telegram.');
  if (r.data.state === 'user') {
    me = r.data.user; applyTheme(me.theme);
    screenMain();
    // Кнопка «Открыть «Входящие»» из ежедневного напоминания
    if (new URLSearchParams(location.search).get('open') === 'inbox') {
      const ov = await api('/api/overview');
      const f = ov.ok && ov.data.folders.find((x) => x.kind === 'inbox');
      if (f) show(() => screenFolder(f.id, f.name, 'inbox'));
    }
    return;
  }
  applyTheme('auto');
  if (r.data.invite === 'admin' || r.data.invite === 'open') return screenJoin('open');
  screenJoin(r.data.invite === 'none' ? 'missing' : r.data.invite);
})();
