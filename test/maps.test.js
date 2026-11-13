import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBoard, cleanTree, titleOf } from '../src/maps.js';

const node = (id, x = 0, y = 0, topic = id) => ({ id, x, y, topic });

test('доска: нормальные данные проходят, лишнее отбрасывается', () => {
  const b = cleanBoard({ nodes: [{ ...node('a', 1.4, 2.6), evil: 'x', color: '#e5484d' }, node('b')], edges: [{ from: 'a', to: 'b', z: 1 }] });
  assert.equal(b.kind, 'board');
  assert.deepEqual(b.nodes[0], { id: 'a', x: 1, y: 3, topic: 'a', color: '#e5484d' });
  assert.deepEqual(b.edges, [{ from: 'a', to: 'b' }]);
});
test('доска: плохой цвет и повторные линии', () => {
  const b = cleanBoard({ nodes: [{ ...node('a'), color: 'url(x)' }, node('b')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] });
  assert.equal(b.nodes[0].color, undefined);
  assert.equal(b.edges.length, 1);
});
test('доска: отклоняются петля, чужой номер, повтор номера, плохие координаты, избыток', () => {
  assert.equal(cleanBoard({ nodes: [node('a')], edges: [{ from: 'a', to: 'a' }] }), null);
  assert.equal(cleanBoard({ nodes: [node('a')], edges: [{ from: 'a', to: 'zz' }] }), null);
  assert.equal(cleanBoard({ nodes: [node('a'), node('a')], edges: [] }), null);
  assert.equal(cleanBoard({ nodes: [node('a', 1e9, 0)], edges: [] }), null);
  assert.equal(cleanBoard({ nodes: [node('<b>')], edges: [] }), null);
  assert.equal(cleanBoard({ nodes: Array.from({ length: 401 }, (_, i) => node('n' + i)), edges: [] }), null);
  assert.equal(cleanBoard(null), null);
});
test('доска: название берётся с первого окошка; дерево по-прежнему работает', () => {
  assert.equal(titleOf(cleanBoard({ nodes: [node('a', 0, 0, 'Машины')], edges: [] })), 'Машины');
  assert.equal(titleOf(cleanTree({ id: 'r', topic: 'Центр' })), 'Центр');
});
test('доска: две линии между парой (туда и обратно) не принимаются, круг из трёх допустим', () => {
  assert.equal(cleanBoard({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), null);
  const ring = cleanBoard({ nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] });
  assert.equal(ring.edges.length, 3);
});
