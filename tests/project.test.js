'use strict';
// Testes do formato de projeto nativo .bastidor (issue #29, fase 2): round
// trip completo (objetos + fios + parâmetros sobrevivem), tolerância a
// campos ausentes e rejeição de conteúdo inválido.

const test = require('node:test');
const assert = require('node:assert');

const Project = require('../src/core/project');
const ObjectModel = require('../src/core/objectmodel');

function sampleDesign() {
  return {
    name: 'meu-projeto',
    metadata: { author: 'teste' },
    threads: [{ color: '#ff0000', description: 'Vermelho', catalog: null, brand: null }],
    objects: [ObjectModel.makeObject('text', { text: 'A', fontId: 'x.svg' }, { heightMm: 10, stitchLengthMm: 2 }, 1)],
    stitches: [
      [0, 0, 1],
      [100, 0, 0],
      [100, 100, 0],
      [0, 0, 5],
    ],
  };
}

test('serializeProject/parseProject: round trip completo preserva objetos, fios e agulhadas', () => {
  const design = sampleDesign();
  const json = Project.serializeProject(design);
  const parsed = Project.parseProject(json);

  assert.equal(parsed.name, 'meu-projeto');
  assert.deepStrictEqual(parsed.metadata, { author: 'teste' });
  assert.equal(parsed.threads.length, 1);
  assert.equal(parsed.threads[0].color, '#ff0000');
  assert.equal(parsed.objects.length, 1);
  assert.equal(parsed.objects[0].type, 'text');
  assert.equal(parsed.objects[0].source.text, 'A');
  assert.equal(parsed.objects[0].stitchParams.heightMm, 10);
  assert.equal(parsed.objects[0].blockCount, 1);
  assert.deepStrictEqual(parsed.stitches, design.stitches);
});

test('parseProject: tolera threads/objects/metadata ausentes (só stitches é obrigatório)', () => {
  const json = JSON.stringify({ formatVersion: 1, stitches: [[0, 0, 0]] });
  const parsed = Project.parseProject(json);
  assert.deepStrictEqual(parsed.threads, []);
  assert.deepStrictEqual(parsed.objects, []);
  assert.deepStrictEqual(parsed.metadata, {});
  assert.equal(parsed.name, null);
  assert.deepStrictEqual(parsed.stitches, [[0, 0, 0]]);
});

test('parseProject: rejeita JSON malformado', () => {
  assert.throws(() => Project.parseProject('{ isso não é json'), /project: JSON inválido/);
});

test('parseProject: rejeita conteúdo que não é um objeto (array/primitivo)', () => {
  assert.throws(() => Project.parseProject('[1,2,3]'), /não é um objeto/);
  assert.throws(() => Project.parseProject('"oi"'), /não é um objeto/);
});

test('parseProject: rejeita objeto sem "stitches"', () => {
  assert.throws(() => Project.parseProject(JSON.stringify({ name: 'x' })), /stitches.*ausente/);
});

test('serializeProject: rejeita design sem stitches', () => {
  assert.throws(() => Project.serializeProject({}), /stitches ausente/);
  assert.throws(() => Project.serializeProject(null), /stitches ausente/);
});

test('serializeProject: objects/threads ausentes no design viram array vazio no JSON, não quebram', () => {
  const json = Project.serializeProject({ stitches: [[1, 2, 0]] });
  const parsed = Project.parseProject(json);
  assert.deepStrictEqual(parsed.objects, []);
  assert.deepStrictEqual(parsed.threads, []);
  assert.deepStrictEqual(parsed.stitches, [[1, 2, 0]]);
});
