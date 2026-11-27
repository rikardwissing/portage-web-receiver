(function (root) {
  'use strict';
  var LINE_MS = 6000, ENTER_MS = 300, LEAVE_MS = 400, RISE_MS = 3200;
  var MAX_LINES = 3, MAX_REACTIONS = 8, MAX_SEEN = 200, CHECK_MS = 1000;
  var CAPSULE = 'rgba(11,13,34,0.8)';
  var LINE_SIZE = 0.029, EMOJI_EM = 2.15, COLUMN_WIDTH_EM = 7.3, COLUMN_HEIGHT_EM = 10, RISE_EM = 6.3, SPREAD_EM = 3.76, SWAY_EM = 0.47, FADE_MS = 900;
  var FONT = 'Inter,-apple-system,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"';
  function clip(value, max) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (text.length > max) text = text.slice(0, max).replace(/[\ud800-\udbff]$/, '');
    return text;
  }
  function tint(value) {
    return /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(String(value)) ? String(value) : '#19D8E6';
  }
  function prefixed(style, name, value) {
    style['webkit' + name.charAt(0).toUpperCase() + name.slice(1)] = value;
    style[name] = value;
  }
  function fonts(base) {
    if (!document.head || !document.getElementById || document.getElementById('portage-inter')) return;
    var style = document.createElement('style');
    style.id = 'portage-inter';
    var face = function (weight, file) {
      return '@font-face{font-family:Inter;font-style:normal;font-weight:' + weight + ';font-display:swap;src:url("' + base + file + '") format("woff2")}';
    };
    style.textContent = face(400, 'Inter-Regular.woff2') + face(700, 'Inter-Bold.woff2');
    document.head.appendChild(style);
  }
  function motion() {
    if (!document.head || !document.getElementById || document.getElementById('portage-watch-motion')) return;
    var style = document.createElement('style');
    style.id = 'portage-watch-motion';
    var sway = 'from{-webkit-transform:translateX(-' + SWAY_EM + 'em);transform:translateX(-' + SWAY_EM + 'em)}to{-webkit-transform:translateX(' + SWAY_EM + 'em);transform:translateX(' + SWAY_EM + 'em)}';
    var pop = '0%{-webkit-transform:scale(1.45);transform:scale(1.45)}55%{-webkit-transform:scale(0.94);transform:scale(0.94)}80%{-webkit-transform:scale(1.03);transform:scale(1.03)}100%{-webkit-transform:scale(1);transform:scale(1)}';
    style.textContent = '@-webkit-keyframes pwl-sway{' + sway + '}@keyframes pwl-sway{' + sway + '}@-webkit-keyframes pwl-pop{' + pop + '}@keyframes pwl-pop{' + pop + '}';
    document.head.appendChild(style);
  }
  function isTone(cp) { return cp >= 0x1f3fb && cp <= 0x1f3ff; }
  function isRegional(cp) { return cp >= 0x1f1e6 && cp <= 0x1f1ff; }
  function isTag(cp) { return cp >= 0xe0020 && cp <= 0xe007f; }
  function isKeycapBase(cp) { return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39); }
  function startsEmoji(cp, next) {
    if (cp >= 0x1f000 && cp <= 0x1faff) return true;
    if (cp === 0xa9 || cp === 0xae || cp === 0x203c || cp === 0x2049 || cp === 0x2122 || cp === 0x2139 ||
        (cp >= 0x2190 && cp <= 0x21ff) || cp === 0x3030 || cp === 0x303d || cp === 0x3297 || cp === 0x3299) return next === 0xfe0f;
    return (cp >= 0x231a && cp <= 0x23ff) || (cp >= 0x25a0 && cp <= 0x27bf) || (cp >= 0x2900 && cp <= 0x2bff);
  }
  function points(text) {
    var out = [], i = 0, hi, lo;
    while (i < text.length) {
      hi = text.charCodeAt(i++);
      if (hi >= 0xd800 && hi <= 0xdbff && i < text.length) {
        lo = text.charCodeAt(i);
        if (lo >= 0xdc00 && lo <= 0xdfff) { out.push((hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000); i++; continue; }
      }
      out.push(hi);
    }
    return out;
  }
  function chars(cps) {
    var out = '', cp;
    for (var i = 0; i < cps.length; i++) {
      cp = cps[i];
      if (cp > 0xffff) { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
      else out += String.fromCharCode(cp);
    }
    return out;
  }
  function emojiEnd(cps, at) {
    var cp = cps[at], i = at + 1;
    if (isRegional(cp)) return i < cps.length && isRegional(cps[i]) ? i + 1 : i;
    if (isKeycapBase(cp)) {
      if (cps[i] === 0xfe0f) i++;
      return cps[i] === 0x20e3 ? i + 1 : -1;
    }
    if (!startsEmoji(cp, cps[i])) return -1;
    for (;;) {
      while (i < cps.length && (cps[i] === 0xfe0f || cps[i] === 0xfe0e || cps[i] === 0x20e3 || isTone(cps[i]) || isTag(cps[i]))) i++;
      if (cps[i] === 0x200d && i + 1 < cps.length && startsEmoji(cps[i + 1], cps[i + 2])) i += 2;
      else return i;
    }
  }
  function split(text) {
    var cps = points(String(text)), runs = [], buffer = [], i = 0, end;
    function flush() { if (buffer.length) { runs.push({text: chars(buffer)}); buffer = []; } }
    while (i < cps.length) {
      end = emojiEnd(cps, i);
      if (end < 0) { buffer.push(cps[i++]); continue; }
      flush();
      runs.push({text: chars(cps.slice(i, end)), emoji: cps.slice(i, end)});
      i = end;
    }
    flush();
    return runs;
  }
  function hex(cps) {
    var names = [];
    for (var i = 0; i < cps.length; i++) {
      if (cps[i] === 0xfe0f || cps[i] === 0xfe0e) continue;
      var h = cps[i].toString(16);
      while (h.length < 4) h = '0' + h;
      names.push(h);
    }
    return 'emoji_u' + names.join('_') + '.png';
  }
  function candidates(cps) {
    var list = [hex(cps)], i;
    for (i = 0; i < cps.length; i++) if (cps[i] === 0x200d) return list;
    var base = hex(cps.slice(0, 1));
    if (base !== list[0] && !isRegional(cps[0]) && !isKeycapBase(cps[0])) list.push(base);
    return list;
  }
  var missing = {};
  function glyph(base, run, size) {
    var names = candidates(run.emoji), at = 0;
    while (at < names.length && missing[names[at]]) at++;
    if (at >= names.length) return document.createTextNode(run.text);
    var img = document.createElement('img');
    img.alt = run.text;
    img.style.cssText = 'height:' + size + 'em;width:auto;vertical-align:-0.2em;margin:0 0.03em';
    img.onerror = function () {
      missing[names[at]] = true;
      do { at++; } while (at < names.length && missing[names[at]]);
      if (at < names.length) img.src = base + names[at];
      else if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(run.text), img);
    };
    img.src = base + names[at];
    return img;
  }
  function fill(parent, text, base, size) {
    var runs = split(text);
    for (var i = 0; i < runs.length; i++) {
      parent.appendChild(runs[i].emoji ? glyph(base, runs[i], size) : document.createTextNode(runs[i].text));
    }
  }
  function detach(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }
  function animating(style, on) {
    style.willChange = on ? 'transform, opacity' : 'auto';
  }
  function Layer(options) {
    this.options = options || {};
    this.lines = []; this.reactions = []; this.seen = {}; this.seenOrder = []; this.spread = -1;
    this.timer = null; this.signature = ''; this.statusText = ''; this.shown = false;
    fonts(this.options.fonts == null ? 'fonts/' : this.options.fonts);
    motion();
    this.box = document.createElement('div');
    this.box.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:1001;display:none;line-height:1.25;color:#fff';
    this.box.style.fontFamily = FONT;
    this.column = document.createElement('div');
    this.column.style.cssText = 'position:absolute;left:5%;max-width:44%';
    this.rising = document.createElement('div');
    this.rising.style.cssText = 'position:absolute;right:5%';
    this.rising.style.width = COLUMN_WIDTH_EM + 'em';
    this.rising.style.height = COLUMN_HEIGHT_EM + 'em';
    this.status = document.createElement('div');
    this.status.style.cssText = 'position:absolute;left:0;right:0;top:5%;text-align:center;display:none';
    this.statusPill = document.createElement('span');
    this.statusPill.style.cssText = 'display:inline-block;max-width:80%;box-sizing:border-box;padding:0.42em 1em;border-radius:1.2em;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.9em;color:rgba(255,255,255,0.78)';
    this.statusPill.style.background = CAPSULE;
    this.status.appendChild(this.statusPill);
    this.box.appendChild(this.column);
    this.box.appendChild(this.rising);
    this.box.appendChild(this.status);
    document.body.appendChild(this.box);
    var self = this;
    if (root.addEventListener) root.addEventListener('resize', function () { self.signature = ''; self.tick(); });
  }
  Layer.prototype.emojiBase = function () { return this.options.emoji == null ? 'emoji/' : this.options.emoji; };
  Layer.prototype.handle = function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.op === 'line') this.line(message);
    else if (message.op === 'react') this.react(message);
    else if (message.op === 'status') this.setStatus(message);
    else if (message.op === 'clear') this.clear();
  };
  Layer.prototype.setStatus = function (message) {
    var text = clip(message && message.text, 80);
    this.statusText = text;
    this.statusPill.textContent = text;
    this.status.style.display = text ? 'block' : 'none';
    this.ensure();
  };
  Layer.prototype.fresh = function (id) {
    if (id == null || id === '') return true;
    var key = 'id:' + String(id);
    if (this.seen[key]) return false;
    this.seen[key] = true; this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN) delete this.seen[this.seenOrder.shift()];
    return true;
  };
  Layer.prototype.line = function (message) {
    message = message || {};
    var text = clip(message.text, 200), name = clip(message.name, 40);
    if (!text || !this.fresh(message.id)) return;
    var row = document.createElement('div');
    row.style.cssText = 'margin-top:0.38em;opacity:0';
    animating(row.style, true);
    prefixed(row.style, 'transform', 'translateY(0.6em)');
    var capsule = document.createElement('span');
    capsule.style.cssText = 'display:inline-block;max-width:100%;box-sizing:border-box;padding:0.38em 0.77em;border-radius:1.08em';
    capsule.style.background = CAPSULE;
    var body = document.createElement('span');
    body.style.cssText = 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;text-overflow:ellipsis;word-wrap:break-word';
    var label = document.createElement('b');
    label.style.fontWeight = '700';
    label.style.color = tint(message.tint);
    label.textContent = name;
    body.appendChild(label);
    body.appendChild(document.createTextNode((name ? '  ' : '') + text));
    capsule.appendChild(body);
    row.appendChild(capsule);
    this.column.appendChild(row);
    var self = this, entry = {row: row, leaving: false, timer: null};
    this.lines.push(entry);
    while (this.live().length > MAX_LINES) this.leave(this.live()[0]);
    entry.timer = setTimeout(function () { self.leave(entry); }, LINE_MS);
    setTimeout(function () { if (!entry.leaving) animating(row.style, false); }, ENTER_MS + 50);
    this.ensure();
    void row.offsetHeight;
    var ease = 'opacity ' + (ENTER_MS / 1000) + 's ease-out,-webkit-transform ' + (ENTER_MS / 1000) + 's ease-out,transform ' + (ENTER_MS / 1000) + 's ease-out';
    prefixed(row.style, 'transition', ease);
    prefixed(row.style, 'transform', 'translateY(0)');
    this.restyle();
  };
  Layer.prototype.live = function () {
    var result = [];
    for (var i = 0; i < this.lines.length; i++) if (!this.lines[i].leaving) result.push(this.lines[i]);
    return result;
  };
  Layer.prototype.restyle = function () {
    var live = this.live();
    for (var i = 0; i < live.length; i++) live[i].row.style.opacity = live.length > 1 && i === 0 ? '0.62' : '1';
  };
  Layer.prototype.leave = function (entry) {
    if (!entry || entry.leaving) return;
    entry.leaving = true;
    if (entry.timer) clearTimeout(entry.timer);
    animating(entry.row.style, true);
    prefixed(entry.row.style, 'transition', 'opacity ' + (LEAVE_MS / 1000) + 's ease-in');
    entry.row.style.opacity = '0';
    var self = this;
    entry.timer = setTimeout(function () {
      detach(entry.row);
      for (var i = 0; i < self.lines.length; i++) if (self.lines[i] === entry) { self.lines.splice(i, 1); break; }
    }, LEAVE_MS);
    this.restyle();
  };
  Layer.prototype.react = function (message) {
    message = message || {};
    var emoji = clip(message.emoji, 16), name = clip(message.name, 40);
    if (!emoji || !this.fresh(message.id)) return;
    while (this.reactions.length >= MAX_REACTIONS) this.drop(this.reactions[0]);
    var spread = Math.random();
    if (this.spread >= 0) while (Math.abs(spread - this.spread) < 0.3) spread = Math.random();
    this.spread = spread;
    var riseMs = Math.round(RISE_MS * (0.85 + Math.random() * 0.3));
    var shift = 'translateX(-' + (spread * SPREAD_EM).toFixed(2) + 'em) ';
    var node = document.createElement('div');
    node.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;text-align:center;opacity:1';
    animating(node.style, true);
    prefixed(node.style, 'transform', shift + 'translateY(0)');
    var sway = document.createElement('div');
    prefixed(sway.style, 'animation', 'pwl-sway 0.75s ease-in-out infinite alternate');
    var pop = document.createElement('div');
    prefixed(pop.style, 'transformOrigin', '50% 100%');
    prefixed(pop.style, 'animation', 'pwl-pop 0.45s ease-out both');
    var face = document.createElement('div');
    face.style.cssText = 'line-height:1.1';
    face.style.fontSize = EMOJI_EM + 'em';
    fill(face, emoji, this.emojiBase(), 1);
    var label = document.createElement('span');
    label.style.cssText = 'display:inline-block;max-width:100%;box-sizing:border-box;padding:0.08em 0.55em;border-radius:1em;font-size:0.68em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;background:rgba(0,0,0,0.55)';
    label.textContent = name;
    pop.appendChild(face);
    pop.appendChild(label);
    sway.appendChild(pop);
    node.appendChild(sway);
    this.rising.appendChild(node);
    var self = this, entry = {node: node, timer: null};
    this.reactions.push(entry);
    entry.timer = setTimeout(function () { self.drop(entry); }, riseMs);
    this.ensure();
    void node.offsetHeight;
    var rise = (riseMs / 1000) + 's cubic-bezier(0,0,0.58,1)';
    var fade = 'opacity ' + (FADE_MS / 1000) + 's ease-in ' + ((riseMs - FADE_MS) / 1000) + 's';
    prefixed(node.style, 'transition', fade + ',-webkit-transform ' + rise + ',transform ' + rise);
    prefixed(node.style, 'transform', shift + 'translateY(-' + RISE_EM + 'em)');
    node.style.opacity = '0';
  };
  Layer.prototype.drop = function (entry) {
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    detach(entry.node);
    for (var i = 0; i < this.reactions.length; i++) if (this.reactions[i] === entry) { this.reactions.splice(i, 1); break; }
  };
  Layer.prototype.clear = function () {
    var i;
    for (i = 0; i < this.lines.length; i++) { if (this.lines[i].timer) clearTimeout(this.lines[i].timer); detach(this.lines[i].row); }
    for (i = 0; i < this.reactions.length; i++) { if (this.reactions[i].timer) clearTimeout(this.reactions[i].timer); detach(this.reactions[i].node); }
    this.lines = []; this.reactions = [];
    this.statusText = ''; this.statusPill.textContent = ''; this.status.style.display = 'none';
    this.tick();
  };
  Layer.prototype.ensure = function () {
    var self = this;
    if (!this.timer) this.timer = setInterval(function () { self.tick(); }, CHECK_MS);
    this.tick();
  };
  Layer.prototype.tick = function () {
    if (!this.lines.length && !this.reactions.length && !this.statusText) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.hide();
      return;
    }
    var video = this.options.video ? this.options.video() : null;
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 1) { this.hide(); return; }
    var rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) { this.hide(); return; }
    var scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    var width = video.videoWidth * scale, height = video.videoHeight * scale;
    var left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    var subtitle = Math.max(16, Math.min(72, height * 0.045));
    var bottom = Math.max(height * 0.05, height * 0.04 + subtitle * 1.2 * 2.6);
    var signature = left + '|' + top + '|' + width + '|' + height;
    if (!this.shown) { this.box.style.display = 'block'; this.shown = true; }
    if (signature === this.signature) return;
    this.signature = signature;
    this.box.style.left = left + 'px'; this.box.style.top = top + 'px';
    this.box.style.width = width + 'px'; this.box.style.height = height + 'px';
    this.box.style.fontSize = Math.max(14, height * LINE_SIZE) + 'px';
    this.column.style.bottom = bottom + 'px';
    this.rising.style.bottom = bottom + 'px';
  };
  Layer.prototype.hide = function () {
    if (this.shown) { this.box.style.display = 'none'; this.shown = false; }
    this.signature = '';
  };
  root.PortageWatchLines = {Layer: Layer, split: split, emojiFile: function (cps) { return hex(cps); }, emojiCandidates: candidates};
}(typeof window !== 'undefined' ? window : this));
