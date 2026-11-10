import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply } from '../src/deepseek.js';

const folders = ['Идеи', 'Задачи', 'Покупки', 'Разное'];

test('известная папка принимается, регистр приводится к имени из списка', () => {
  const r = parseModelReply('{"text":"Купить хлеб","folder":"покупки","new_folder":false}', folders, 'купить хлеп');
  assert.deepEqual(r.notes, [{ text: 'Купить хлеб', folder: 'Покупки', isNewFolder: false, remind: null }]);
  assert.deepEqual(r.shopping, []);
});
test('новая папка с нормальным именем создаётся', () => {
  const r = parseModelReply('{"text":"Отпуск","folder":"Путешествия"}', folders, 'отпуск').notes[0];
  assert.equal(r.isNewFolder, true);
  assert.equal(r.folder, 'Путешествия');
});
test('странное имя папки не принимается, текст сохраняется', () => {
  const r = parseModelReply('{"text":"Привет","folder":"<script>alert(1)</script>"}', folders, 'привет').notes[0];
  assert.equal(r.folder, null);
});
test('мусор и не-JSON отклоняются', () => {
  assert.equal(parseModelReply('', folders, 'a'), null);
  assert.equal(parseModelReply('не json', folders, 'a'), null);
  assert.equal(parseModelReply('{"folder":"Идеи"}', folders, 'a'), null);
});
test('текст, сильно длиннее исходного, отклоняется', () => {
  assert.equal(parseModelReply(JSON.stringify({ text: 'x'.repeat(500), folder: 'Идеи' }), folders, 'коротко'), null);
});

test('напоминание разбирается, мусор в remind отбрасывается', () => {
  const ok = parseModelReply(JSON.stringify({ text: 'Позвонить', folder: 'Задачи', remind: { at: '2026-11-11T09:00:00', in_minutes: null, repeat: null, text: 'Позвонить Ивану' } }), folders, 'позвонить');
  assert.equal(ok.notes[0].remind.at, '2026-11-11T09:00:00');
  assert.equal(ok.notes[0].remind.text, 'Позвонить Ивану');
  const bad = parseModelReply(JSON.stringify({ text: 'Позвонить', folder: 'Задачи', remind: { at: 'завтра', in_minutes: 'скоро', repeat: { weekdays: [9, 0] } } }), folders, 'позвонить');
  assert.equal(bad.notes[0].remind, null);
});

test('сообщение делится на заметки, покупки собираются в список', () => {
  const raw = JSON.stringify({
    notes: [{ text: 'Записаться к врачу.', folder: 'Задачи', remind: { at: '2026-11-11T09:00:00' } }, { text: 'Записаться на курсы.', folder: 'Задачи' }],
    shopping: ['Хлеб', 'Сметана', 'хлеб', '  ', 5],
  });
  const r = parseModelReply(raw, folders, 'купить хлеба потом завтра в 9 записаться к врачу а ещё сметану и записаться на курсы');
  assert.equal(r.notes.length, 2);
  assert.deepEqual(r.shopping, ['Хлеб', 'Сметана']);   // дубли и мусор убраны
});
test('только покупки: заметок нет, это нормально', () => {
  const r = parseModelReply('{"notes": [], "shopping": ["Хлеб"]}', folders, 'купить хлеб');
  assert.deepEqual(r, { notes: [], shopping: ['Хлеб'] });
});
test('пустой разбор отклоняется', () => {
  assert.equal(parseModelReply('{"notes": [], "shopping": []}', folders, 'что-то'), null);
});
test('больше 10 заметок: хвост склеивается в последнюю', () => {
  const notes = Array.from({ length: 13 }, (_, i) => ({ text: `Дело ${i + 1}`, folder: 'Задачи' }));
  const r = parseModelReply(JSON.stringify({ notes, shopping: [] }), folders, notes.map((n) => n.text).join(' '));
  assert.equal(r.notes.length, 10);
  assert.match(r.notes[9].text, /Дело 10 Дело 11 Дело 12 Дело 13/);
});
test('выдуманный лишний текст отклоняется', () => {
  assert.equal(parseModelReply(JSON.stringify({ notes: [], shopping: ['Хлеб'.repeat(15)] }), folders, 'х'.repeat(3)), null);
});

test('пустышка вместо текста напоминания отбрасывается', () => {
  const r = parseModelReply(JSON.stringify({ text: 'Напомнить через 3 минуты.', folder: 'Задачи', remind: { in_minutes: 3, text: 'Напоминание' } }), folders, 'напомнить через 3 минуты');
  assert.equal(r.notes[0].remind.text, null);
});
