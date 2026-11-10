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

const TABS = [['notes', '📁', 'Заметки'], ['shop', '🛒', 'Покупки'], ['cal', '📅', 'Календарь']];
function frame(active, inner) {
  h(`<header class="topbar"><span class="brand">Блокнот</span>
      <button id="settingsBtn" class="gear nosel" aria-label="Настройки">⚙️</button></header>
    ${inner}
    <nav class="tabbar">${TABS.map(([k, ic, t]) => `<button data-tab="${k}" class="${k === active ? 'on' : ''}"><span>${ic}</span>${t}</button>`).join('')}</nav>`);
  // Нажатие открывает настройки, удержание 2 секунды открывает панель управления (только у админа)
  holdToOpen($('settingsBtn'), () => show(screenSettings), me.is_admin ? () => show(screenAdmin) : null);
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
  const { folders } = ov.data;
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
      if (!(await confirmBox('Удалить задачу?'))) return;
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
    if (!(await confirmBox(`Удалить папку «${name}»? Заметки перейдут в «Разное».`))) return;
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
      <select id="nfolder">${folders.map((f) => `<option value="${f.id}" ${f.id === note.folder_id ? 'selected' : ''}>📁 ${esc(f.name)}</option>`).join('')}</select>
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
  $('ntext').oninput = dirty; $('nfolder').onchange = dirty;
  $('save').onclick = async () => {
    $('save').disabled = true;
    const r = await api('/api/notes/update', { id, text: $('ntext').value, folder_id: Number($('nfolder').value) });
    if (r.ok) { toast('Сохранено'); haptic(); screenNote(id); } else { notify(errText(r.data.error)); dirty(); }
  };
  $('delNote').onclick = async () => {
    if (!(await confirmBox('Удалить заметку?'))) return;
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

// ---------- вкладка «Покупки» ----------
async function screenShopping() {
  frame('shop', `<div class="card"><h2>🛒 Список покупок</h2>
      <div class="addrow"><input id="item" maxlength="60" placeholder="Что купить?" autocomplete="off"><button id="add" class="addbtn">+</button></div>
      <div id="items"><p class="muted">Загрузка…</p></div></div>`);
  let items = [];
  const draw = () => {
    const open = items.filter((i) => !i.done), done = items.filter((i) => i.done);
    const row = (i) => `<div class="shop ${i.done ? 'done' : ''}" data-id="${i.id}"><span class="box">${i.done ? '✓' : ''}</span><span class="name">${esc(i.name)}</span><button class="x" data-del="${i.id}" aria-label="Убрать">✕</button></div>`;
    $('items').innerHTML = (open.map(row).join('') || '<p class="muted">Всё куплено или список пуст.</p>')
      + (done.length ? `<div class="sep">Куплено</div>${done.map(row).join('')}<button class="ghost wide" id="clear">Очистить купленное (${done.length})</button>` : '');
  };
  const load = async () => { const r = await api('/api/shopping'); if (r.ok) { items = r.data.items; draw(); } };
  const act = async (path, body) => { const r = await api(path, body); if (r.ok) { items = r.data.items; draw(); } return r; };
  await load();
  $('items').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return act('/api/shopping/delete', { id: Number(del.dataset.del) });
    if (e.target.id === 'clear') return act('/api/shopping/clear', {});
    const row = e.target.closest('.shop');
    if (!row) return;
    // Сразу меняем вид, затем подтверждаем на сервере
    const it = items.find((i) => i.id === Number(row.dataset.id));
    if (it) { it.done = it.done ? 0 : 1; draw(); haptic1(); }
    act('/api/shopping/toggle', { id: Number(row.dataset.id) });
  };
  const add = async () => {
    const name = $('item').value.trim();
    if (!name) return;
    $('item').value = '';
    await act('/api/shopping/add', { name });
  };
  $('add').onclick = add;
  $('item').onkeydown = (e) => { if (e.key === 'Enter') add(); };
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
      <h3>Инструменты</h3>
      <button class="ghost wide" id="pwBtn">🔑 Генератор паролей</button>
      <h3>Бот</h3>
      <p id="botstate">${me.can_write ? '✅ Бот подключён и может писать вам.' : 'Разрешите боту писать вам, чтобы он присылал напоминания и принимал заметки.'}</p>
      ${me.can_write ? '' : '<button id="connect">Подключить бота</button>'}
      <p id="err" class="err" hidden></p>
    </section>`);

  $('back').onclick = back;
  $('pwBtn').onclick = () => show(screenPasswords);
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

  $('back').onclick = back;
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
  if (tg) { tg.ready(); tg.expand(); }
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
