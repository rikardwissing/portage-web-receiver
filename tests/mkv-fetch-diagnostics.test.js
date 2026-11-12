'use strict';
const assert = require('node:assert/strict');
global.MediaSource = function () { this.addEventListener = function () {}; };
URL.createObjectURL = () => 'blob:test';
const { MkvEngine } = require('../mkv-engine.js');
(async () => {
  const logs = [];
  const engine = new MkvEngine('https://example.invalid/video?X-Plex-Token=secret', 0, {log: line => logs.push(line)});
  clearInterval(engine.stallTimer);
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(engine.fetcher(20, 29), /Failed to fetch/);
  assert.match(logs.pop(), /phase=headers status=0/);
  global.fetch = () => Promise.resolve({status:206, redirected:false,
    headers:{get:name => name === 'Content-Length' ? '10' : 'bytes 20-29/100'},
    arrayBuffer:() => Promise.reject(new TypeError('Failed to fetch'))});
  await assert.rejects(engine.fetcher(20, 29), /Failed to fetch/);
  const body = logs.pop();
  assert.match(body, /phase=body status=206 length=10/);
  assert.ok(!body.includes('secret') && !body.includes('example.invalid'));
  global.fetch = () => Promise.resolve({status:503, redirected:true,headers:{get:() => null}});
  await assert.rejects(engine.fetcher(20, 29), /HTTP 503/);
  assert.match(logs.pop(), /phase=status status=503 length=\? redirected=true/);
  console.log('mkv-fetch-diagnostics: distinguishes pre-header, HTTP status and body failures without URLs');
})().catch(error => { console.error(error); process.exitCode = 1; });
