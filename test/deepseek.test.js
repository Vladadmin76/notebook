import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply } from '../src/deepseek.js';

const folders = ['Идеи', 'Задачи', 'Покупки', 'Разное'];

test('известная папка принимается, регистр приводится к имени из списка', () => {
  const r = parseModelReply('{"text":"Купить хлеб","folder":"покупки","new_folder":false}', folders, 'купить хлеп');
  assert.deepEqual(r, { text: 'Купить хлеб', folder: 'Покупки', isNewFolder: false });
});
test('новая папка с нормальным именем создаётся', () => {
  const r = parseModelReply('{"text":"Отпуск","folder":"Путешествия"}', folders, 'отпуск');
  assert.equal(r.isNewFolder, true);
  assert.equal(r.folder, 'Путешествия');
});
test('странное имя папки не принимается, текст сохраняется', () => {
  const r = parseModelReply('{"text":"Привет","folder":"<script>alert(1)</script>"}', folders, 'привет');
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
