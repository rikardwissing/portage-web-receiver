'use strict';
const assert = require('node:assert/strict');
global.MediaSource = function () {};
const { MkvEngine } = require('../mkv-engine.js');
const engine = Object.create(MkvEngine.prototype);
for (const codec of ['S_TEXT/ASS', 'S_TEXT/SSA']) {
  assert.equal(engine.subtitleText_(codec, new TextEncoder().encode('0,0,Default,,0,0,0,,{\\pos(100,20)}Sign')), null);
}
assert.equal(engine.subtitleText_('S_TEXT/UTF8', new TextEncoder().encode('Plain subtitle')), 'Plain subtitle');
console.log('mkv-ass-fidelity: ASS/SSA cannot enter the plain-text path');
