import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTask, loadTaskRouterConfig } from '@/modules/task-router/services/task-router.service.js';

test('loadTaskRouterConfig reads the repo-root config.json and returns a non-empty list for every tag', () => {
  const config = loadTaskRouterConfig();
  for (const tag of ['routine', 'coding', 'second_opinion', 'complex'] as const) {
    assert.ok(Array.isArray(config[tag]), `${tag} should be an array`);
    assert.ok(config[tag].length > 0, `${tag} should have at least one default keyword`);
  }
});

test('classifyTask returns the explicit tag outright, even when the text matches a different tag\'s keywords', () => {
  assert.equal(classifyTask('please fix this bug in the code', 'routine'), 'routine');
});

test('classifyTask matches "routine" from its own config keyword', () => {
  assert.equal(classifyTask('Это рутинная задача, переименуй переменную'), 'routine');
});

test('classifyTask matches "coding" from its own config keyword', () => {
  assert.equal(classifyTask('Implement a new function to parse dates'), 'coding');
});

test('classifyTask matches "second_opinion" from its own config keyword', () => {
  assert.equal(classifyTask('Мне нужно второе мнение по этому решению'), 'second_opinion');
});

test('classifyTask matches "complex" from its own config keyword', () => {
  assert.equal(classifyTask('Это сложное решение по архитектуре сервиса'), 'complex');
});

test('classifyTask is case-insensitive', () => {
  assert.equal(classifyTask('IMPLEMENT the login flow'), 'coding');
});

test('classifyTask returns null when no keyword matches and no explicit tag was given', () => {
  assert.equal(classifyTask('Расскажи, какая сегодня погода'), null);
});
