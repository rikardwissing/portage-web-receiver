'use strict';
const assert = require('node:assert/strict');
global.MediaSource = function () {};
const { MkvEngine } = require('../mkv-engine.js');

const originalNow = Date.now;
let now = 100000;
Date.now = () => now;
function engine(fetcher, ahead = 60) {
  const made = Object.create(MkvEngine.prototype);
  Object.assign(made, {
    dead: false, generation: 1, fetchTimeoutMs: 15000, bytesFetched: 0,
    fetcher, getTime: () => 10, log: () => {},
    lanes: { video: { sb: { buffered: { length: 1, start: () => 0, end: () => 10 + ahead } } } },
    sleep_(ms) { now += ms; return Promise.resolve(); }
  });
  return made;
}

(async () => {
  let attempts = 0;
  const buffered = engine(() => ++attempts < 6
    ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new ArrayBuffer(8)));
  const began = now;
  assert.equal((await buffered.fetchRange_(100, 107, 1)).byteLength, 8);
  assert.equal(attempts, 6);
  assert.equal(buffered.dead, false);
  assert.equal(buffered.lanes.video.sb.buffered.end(0), 70);
  assert.ok(now - began > 2000);
  assert.equal(buffered.retryingFetch_, null);

  const unavailable = engine(() => Promise.reject(new TypeError('Failed to fetch')));
  const lostAt = now;
  await assert.rejects(unavailable.fetchRange_(100, 107, 1), error => error.portageNetwork === true);
  assert.ok(now - lostAt >= 75000 && now - lostAt < 80000);

  attempts = 0;
  const gone = engine(() => { attempts++; return Promise.reject(new Error('HTTP 404')); });
  await assert.rejects(gone.fetchRange_(100, 107, 1), error => error.portageNetwork === true);
  assert.equal(attempts, 3);

  attempts = 0;
  const overloaded = engine(() => ++attempts < 5
    ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(new ArrayBuffer(1)), 0);
  await overloaded.fetchRange_(0, 0, 1);
  assert.equal(attempts, 5);

  attempts = 0;
  const slow = engine(() => ++attempts < 6
    ? Promise.reject(new Error('timeout')) : Promise.resolve(new ArrayBuffer(1)), 0);
  slow.sleep_ = () => { now += 100000; return Promise.resolve(); };
  await slow.fetchRange_(0, 0, 1);
  assert.equal(attempts, 6);
  assert.equal(slow.sawSlowFetch, true);

  attempts = 0;
  const superseded = engine(() => { attempts++; return Promise.reject(new TypeError('Failed to fetch')); });
  superseded.sleep_ = () => { superseded.generation++; return Promise.resolve(); };
  await assert.rejects(superseded.fetchRange_(0, 1, 1));
  assert.equal(attempts, 1);

  let report;
  const failed = engine(() => {});
  failed.onEngineFailed = (reason, detail) => { report = { reason, detail }; };
  const failure = new Error('Failed to fetch');
  failure.portageNetwork = true;
  failed.fetchFailed_('fetch@100', failure);
  assert.equal(report.detail.reason, 'network');
  assert.equal(report.detail.track, 'stream');
  assert.match(report.reason, /connection/i);

  const retrying = engine(() => {});
  retrying.demux = { durationMs: () => 1000000 };
  retrying.isBuffered_ = () => false;
  retrying.lastFetchDoneAt = 0;
  retrying.retryingFetch_ = {};
  retrying.repump_ = () => { throw new Error('Must not supersede a pending network retry'); };
  retrying.stallCheck_();
  console.log('mkv-network-recovery: buffered recovery, bounded outage, timeout, cancellation, classification passed');
})().finally(() => { Date.now = originalNow; }).catch(error => { console.error(error); process.exitCode = 1; });
