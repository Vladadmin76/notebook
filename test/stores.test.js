import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, phon, resolveStore, buildEntries, distance } from '../src/stores.js';

const entries = buildEntries([], []);
const ask = (s) => resolveStore(s, entries)?.name ?? null;

test('звучание: кириллица и латиница сводятся к одному ключу', () => {
  assert.equal(phon('Costco'), phon('Костко'));
  assert.equal(phon('Walmart'), phon('Валмарт'));
  assert.equal(phon('Target'), phon('Таргет'));
});
test('известные русские написания и произношения находят нужный магазин', () => {
  assert.equal(ask('Костко'), 'Costco');
  assert.equal(ask('костка'), 'Costco');
  assert.equal(ask('Волмарт'), 'Walmart');
  assert.equal(ask('Таргет'), 'Target');
  assert.equal(ask('Винка Фуд'), 'WinCo Foods');
  assert.equal(ask('Хоум Депо'), 'Home Depot');
  assert.equal(ask('Эйч-И-Би'), 'H-E-B');
  assert.equal(ask('Трейдер Джо'), "Trader Joe's");
});
test('регистр и точное совпадение', () => {
  assert.equal(ask('COSTCO'), 'Costco');
  assert.equal(ask('costco'), 'Costco');
  assert.equal(ask("lowe's"), "Lowe's");
});
test('опечатки и другой выговор находятся по звучанию', () => {
  assert.equal(ask('Костко Холсал'), 'Costco');     // близко к известному написанию
  assert.equal(ask('Costko'), 'Costco');
  assert.equal(ask('Волмат'), 'Walmart');
  assert.equal(ask('Таргэт'), 'Target');
});
test('незнакомый магазин не подменяется похожим', () => {
  assert.equal(ask('Kohls'), null);
  assert.equal(ask('Рога и копыта'), null);
  assert.equal(ask('Best Buy'), null);
  assert.equal(ask('Aldi'), null);
  assert.equal(ask('ab'), null);
});
test('выученное написание и существующий список учитываются', () => {
  const e = buildEntries([{ name: 'Costco', custom: false, favorite: true, aliases: ['Костиково'] }, { name: 'Мой Рынок', custom: true, favorite: true, aliases: [] }], ['Рынок Васи']);
  assert.equal(resolveStore('Костиково', e).name, 'Costco');
  assert.equal(resolveStore('мой рынок', e).name, 'Мой Рынок');
  assert.equal(resolveStore('Рынок Васи', e).source, 'list');
});
test('перечень: 19 сетей, названия не повторяются, группы заданы', () => {
  assert.equal(CATALOG.length, 19);
  assert.equal(new Set(CATALOG.map((c) => c.name.toLowerCase())).size, CATALOG.length);
  assert.ok(CATALOG.every((c) => c.group && c.aliases.length));
});
test('расстояние Левенштейна', () => {
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(distance('', 'abc'), 3);
});
