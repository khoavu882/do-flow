'use strict';

// 162 IC-009 (review 1 finding 6): one list of text vectors, `[raw, normalized]`, that the Console's normalizeText
// (src/actions.ts, actions-routes.test.ts) and the page's (web/derive/actions.js, derive-actions.test.ts) must both
// answer, so the page never lets through a text the server refuses. `null`: no UTF-8 form (a lone surrogate), refused.

const TEXT_VECTORS: ReadonlyArray<readonly [string, string | null]> = Object.freeze([
  ['a\r\nb\tc', 'a b c'],
  ['   x   ', 'x'],
  ['é', 'é'],
  ['a​b‮c⁦d﻿e\u0007f\u009Bg\u007Fh\u0000i', 'abcdefghi'],
  ['a      b', 'a b'],
  ['\u0000‏', ''],
  ['\u007F', ''],
  ['\u007F\u007F x \u007F', 'x'],
  ['-x --json', '-x --json'],
  ['ok 😀', 'ok 😀'],
  ['bad \uD800 half', null],
  ['bad \uDC00', null],
] as const);

module.exports = { TEXT_VECTORS };
