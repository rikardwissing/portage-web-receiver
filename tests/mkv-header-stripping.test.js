'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
global.MediaSource = function () {};
const {MkvDemuxer, Fmp4Muxer, MkvTrackTimeline, MkvEngine} = require('../mkv-engine.js');
const concat = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
const hex = s => Buffer.from(s, 'hex');
function size(n) {
  let width = 1;
  while (n >= 2 ** (7 * width) - 1) width++;
  const b = Buffer.alloc(width); b.writeUIntBE(n, 0, width); b[0] |= 1 << (8 - width); return b;
}
const el = (id, ...body) => {const b = concat(...body); return concat(hex(id), size(b.length), b);};
const uint = (id, n) => el(id, [n]);
const encoding = (prefix, extra = []) => el('6240', ...extra,
  el('5034', uint('4254', 3), el('4255', prefix)));
function file(encodings, blocks, privateBytes = []) {
  return concat(el('1a45dfa3'), el('18538067',
    el('1654ae6b', el('ae', uint('d7', 1), uint('83', 2), el('86', Buffer.from('A_AC3')),
      el('63a2', privateBytes), el('23e383', hex('01e84800')),
      el('e1', el('b5', hex('40e7700000000000')), uint('9f', 6)),
      encodings ? el('6d80', ...encodings) : [])),
    el('1f43b675', uint('e7', 0), ...blocks), el('ec', Buffer.alloc(12))));
}
function read(bytes) {
  const demux = new MkvDemuxer(); assert.equal(demux.parseHeader(bytes), true);
  const samples = [];
  demux.parseClusters(bytes.subarray(demux.firstClusterOffset), demux.firstClusterOffset,
    (number, sample) => samples.push(sample));
  return {demux, samples};
}
const block = (flags, data, group = false) => group
  ? el('a0', el('a1', concat([0x81, 0, 0, flags], data)))
  : el('a3', concat([0x81, 0, 0, flags], data));

test('restores stripped headers on each unlaced frame for all four lacing modes and BlockGroup', () => {
  const a = hex('1234'), b = hex('5678'), prefix = hex('0b77');
  for (const group of [false, true]) for (const lace of [0, 1, 2, 3]) {
    const body = lace === 0 ? a : concat([1], lace === 1 ? [2] : lace === 3 ? [0x82] : [], a, b);
    const bytes = file([encoding(prefix)], [block(0x80 | (lace << 1), body, group)]);
    const before = Buffer.from(bytes), {samples} = read(bytes);
    assert.deepEqual(samples.map(s => Buffer.from(s.data)), (lace ? [a, b] : [a]).map(s => concat(prefix, s)));
    assert.deepEqual(samples.map(s => s.laceIndex), lace ? [0, 1] : [0]);
    assert.deepEqual(bytes, before, 'restoration never changes source bytes');
  }
});

test('obeys encoding scope and reverse order; keeps uncompressed tracks unchanged', () => {
  const payload = hex('99');
  for (const scope of [1, 2, 3]) {
    const {demux, samples} = read(file([encoding([0x42], [uint('5032', scope)])], [block(0x80, payload)], payload));
    assert.deepEqual(Buffer.from(samples[0].data), scope & 1 ? hex('4299') : payload);
    assert.deepEqual(Buffer.from(demux.tracks[0].codecPrivate), scope & 2 ? hex('4299') : payload);
  }
  const {samples} = read(file([encoding([0x11]), encoding([0x22], [uint('5031', 1)])], [block(0x80, payload)]));
  assert.deepEqual(Buffer.from(samples[0].data), hex('112299'));
  assert.deepEqual(Buffer.from(read(file(null, [block(0x80, payload)])).samples[0].data), payload);
});

test('unsupported encodings are reported, never fed to a decoder as clear packets', () => {
  for (const enc of [encoding([1], [uint('5033', 1)]), encoding([1], [uint('5032', 4)]),
    el('6240', el('5034', uint('4254', 0))), encoding([1], [uint('5032', 0)])]) {
    const {demux, samples} = read(file([enc], [block(0x80, [1, 2])]));
    assert.match(demux.tracks[0].encodingError, /unsupported Matroska content encoding/);
    assert.equal(samples.length, 0);
    assert.equal(MkvEngine.prototype.trackSupported_.call({}, demux.tracks[0]), false);
  }
});

test('header-stripped AC-3 remains byte-exact through Matroska and fragmented MP4, with six-channel decode', () => {
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1',
    '-t', '0.128', '-c:a', 'ac3', '-b:a', '640k', '-f', 'ac3', 'pipe:1']);
  assert.equal(generated.status, 0, String(generated.stderr));
  const frames = [];
  for (let i = 0; i < generated.stdout.length; i += 2560) frames.push(generated.stdout.subarray(i, i + 2560));
  assert.equal(frames.length, 4);
  frames.forEach(f => assert.equal(f.subarray(0, 2).toString('hex'), '0b77'));
  const {demux, samples} = read(file([encoding([0x0b, 0x77])], [block(0x84,
    concat([frames.length - 1], ...frames.map(f => f.subarray(2))))]));
  assert.deepEqual(concat(...samples.map(s => s.data)), generated.stdout);
  const track = demux.tracks[0], mux = new Fmp4Muxer(track, 48000), timeline = new MkvTrackTimeline(track, 48000);
  mux.noteFirstFrame(samples[0].data);
  const mp4 = concat(mux.initSegment(128), mux.fragment(samples.map(s => timeline.convert(s))));
  const packets = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-c:a', 'copy', '-f', 'ac3', 'pipe:1'], {input: mp4});
  assert.equal(packets.status, 0, String(packets.stderr));
  assert.deepEqual(packets.stdout, generated.stdout, 'original encoded packets survive both containers');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', 'pipe:0'], {input: mp4});
  assert.equal(probe.status, 0, String(probe.stderr));
  const parsed = JSON.parse(probe.stdout);
  assert.equal(parsed.streams[0].channels, 6);
  assert.deepEqual(parsed.packets.map(p => p.pts_time), ['0.000000', '0.032000', '0.064000', '0.096000']);
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {input: mp4});
  assert.equal(decode.status, 0, String(decode.stderr)); assert.equal(String(decode.stderr), '');
});
