'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lines = require('../watch-lines.js').PortageWatchLines;

function files(text) {
  return lines.split(text).filter(function (run) { return run.emoji; }).map(function (run) { return lines.emojiCandidates(run.emoji); });
}

const cases = [
  ['\u{1F602}', 'emoji_u1f602.png'],
  ['❤️', 'emoji_u2764.png'],
  ['\u{1F44D}\u{1F3FD}', 'emoji_u1f44d_1f3fd.png'],
  ['\u{1FAE3}', 'emoji_u1fae3.png'],
  ['\u{1F3F3}️‍\u{1F308}', 'emoji_u1f3f3_200d_1f308.png'],
  ['\u{1F1F8}\u{1F1EA}', 'emoji_u1f1f8_1f1ea.png'],
  ['1️⃣', 'emoji_u0031_20e3.png']
];

test('each emoji maps to an existing Noto file', function () {
  cases.forEach(function (c) {
    const found = files(c[0]);
    assert.strictEqual(found.length, 1, c[0]);
    assert.strictEqual(found[0][0], c[1], c[0]);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'emoji', c[1])), c[1]);
  });
});

test('plain text and digits stay text, emoji split out of a sentence', function () {
  const runs = lines.split('so 1 fun \u{1F602}\u{1F602} 100%');
  assert.deepStrictEqual(runs.map(function (r) { return !!r.emoji; }), [false, true, true, false]);
  assert.strictEqual(runs[0].text, 'so 1 fun ');
});

test('skin tone falls back to the base emoji, ZWJ sequences do not', function () {
  assert.deepStrictEqual(files('\u{1F44D}\u{1F3FD}')[0], ['emoji_u1f44d_1f3fd.png', 'emoji_u1f44d.png']);
  assert.strictEqual(files('\u{1F3F3}️‍\u{1F308}')[0].length, 1);
});
