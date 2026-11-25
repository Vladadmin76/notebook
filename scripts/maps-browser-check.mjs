// Запускает проверки карт в браузере с касаниями на локальном приложении (npm run dev). Нужен playwright (в проекте не установлен, подключается из окружения).
import { spawnSync } from 'node:child_process';
const want = {
  maps: [/REOPEN colors \["rgb\(229, 72, 77\)"/, /AFTER UNDO nodes 2 before 2/],
  board: [/MERGE nodes 4/, /INSERT nodes 5 edges 5/, /UNDO nodes 4/, /REVERSE true no old true/, /AFTER nodes 3 edges 3 mutual pairs 0 self-loops 0/, /REOPEN nodes 3 edges 3/],
  color: [/MENU items Изменить название\|Добавить ветку\|Изменить цвет\|Добавить точки\|Удалить окошко\|Отмена/, /SWATCHES 11/, /NODE \[ 'rgb\(229, 72, 77\)'/],
  link: [/DOTS 4 stop button true/, /HIGHLIGHT 1/, /EDGES1 a>b/, /TOAST Между ними уже есть линия/, /HIGHLIGHT2 \[ 'Четыре' \]/, /THREAD still in hand true/, /EDGES3 a>b,a>d/, /FROZEN true/, /STOP dots 0 fit button true/],
  mute: [/BUTTONS ⏸ Пауза на сегодня\|Выключить/, /AFTER PAUSE ▶ Продолжить\|⏸ На паузе до конца сегодняшнего дня\./, /AFTER OFF Включить\|true\|true/, /AFTER ON Выключить/],
  join: [/ALLOW \{"calls":1,"can_write":true,"entered":true\}/, /DENY \{"calls":1,"can_write":false,"entered":true\}/, /KNOWN \{"calls":0,"can_write":true,"entered":true\}/],
  list: [/SWIPE open: true/, /DELETED by swipe: 1/, /HOLD open: true/, /TAP on open closes: true/, /TAP opens map: true/],
};
let bad = 0;
for (const [name, checks] of Object.entries(want)) {
  const r = spawnSync('node', [new URL(`./browser/${name}.cjs`, import.meta.url).pathname], { encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' } });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const re of checks) { const ok = re.test(out); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${re.source}`); if (!ok) bad++; }
  if (/PAGEERROR/.test(out)) { console.log(`FAIL  ${name}: ошибка в коде страницы`); console.log(out.split('\n').filter((l) => /PAGEERROR/.test(l)).join('\n')); bad++; }
}
console.log(bad ? `\nНЕ ПРОЙДЕНО: ${bad}` : '\nВсе проверки пройдены');
process.exit(bad ? 1 : 0);
