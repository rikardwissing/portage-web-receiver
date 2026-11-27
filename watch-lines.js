(function (root) {
  'use strict';
  var LINE_MS = 6000, ENTER_MS = 300, LEAVE_MS = 400, RISE_MS = 3200;
  var MAX_LINES = 3, MAX_REACTIONS = 8, MAX_SEEN = 200, CHECK_MS = 1000;
  var CAPSULE = 'rgba(11,13,34,0.8)';
  var LINE_SIZE = 0.029, EMOJI_EM = 2.15, COLUMN_WIDTH_EM = 7.3, COLUMN_HEIGHT_EM = 10, RISE_EM = 6.3, SPREAD_EM = 3.76, SWAY_EM = 0.47, FADE_MS = 900;
  var FONT = 'Inter,-apple-system,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"';
  var CARD_ENTER_MS = 400, CARD_LEAVE_MS = 400;
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
    this.lines = []; this.reactions = []; this.seen = {}; this.seenOrder = []; this.spread = -1; this.risePx = 0;
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
    this.card = null;
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
    else if (message.op === 'suggest') this.suggest(message);
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
    prefixed(node.style, 'transform', shift + 'translateY(' + (this.risePx ? '-' + Math.round(this.risePx) + 'px' : '-' + RISE_EM + 'em') + ')');
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
    if (this.card) { if (this.card.timer) clearTimeout(this.card.timer); this.card.timer = null; this.card.shown = false; this.card.node.style.display = 'none'; }
    this.statusText = ''; this.statusPill.textContent = ''; this.status.style.display = 'none';
    this.tick();
  };
  function poster(node, source) {
    var ok = typeof source === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+\/=]+$/.test(source) && source.length < 200000;
    node.innerHTML = '';
    if (ok) {
      node.style.backgroundImage = 'url("' + source + '")';
      node.style.backgroundColor = '#12153A';
      return;
    }
    node.style.backgroundColor = '#12153A';
    node.style.backgroundImage = 'radial-gradient(circle at 15% 0%,rgba(25,216,230,0.35),rgba(25,216,230,0) 70%),radial-gradient(circle at 100% 100%,rgba(123,69,246,0.3),rgba(123,69,246,0) 70%)';
    var disc = document.createElement('span');
    disc.style.cssText = 'position:absolute;left:50%;top:50%;width:1.15em;height:1.15em;margin:-0.575em 0 0 -0.575em;border-radius:50%;background:rgba(255,255,255,0.16)';
    var play = document.createElement('span');
    play.style.cssText = 'position:absolute;left:0.37em;top:0.3em;width:0;height:0;border-style:solid;border-width:0.17em 0 0.17em 0.3em;border-color:transparent transparent transparent rgba(255,255,255,0.85)';
    disc.appendChild(play);
    node.appendChild(disc);
  }
  Layer.prototype.buildCard = function () {
    var card = document.createElement('div');
    card.style.cssText = 'position:absolute;top:6%;right:6%;display:none;white-space:nowrap;padding:0.55em 0.9em 0.55em 0.55em;border-radius:0.7em;' +
      'background:rgba(11,13,34,0.82);box-shadow:0 0.3em 1em rgba(0,0,0,0.45);opacity:0';
    var art = document.createElement('div');
    art.style.cssText = 'position:relative;display:inline-block;vertical-align:middle;width:3.2em;height:4.8em;border-radius:0.3em;overflow:hidden;' +
      'background-size:cover;background-position:center';
    var text = document.createElement('div');
    text.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:0.65em;max-width:15em;white-space:nowrap';
    var who = document.createElement('div');
    who.style.cssText = 'font-size:0.62em;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#19D8E6;overflow:hidden;text-overflow:ellipsis';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:1.05em;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;line-height:1.15';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:0.66em;color:rgba(255,255,255,0.6);overflow:hidden;text-overflow:ellipsis';
    var votes = document.createElement('div');
    votes.style.cssText = 'margin-top:0.35em;line-height:1.15em;height:1.15em';
    text.appendChild(who); text.appendChild(title); text.appendChild(sub); text.appendChild(votes);
    card.appendChild(art); card.appendChild(text);
    this.box.appendChild(card);
    this.card = {node: card, art: art, who: who, title: title, sub: sub, votes: votes, id: null, until: 0, timer: null, shown: false};
    return this.card;
  };
  Layer.prototype.suggest = function (message) {
    message = message || {};
    var title = clip(message.title, 120);
    if (!title) return;
    var ms = Math.max(1000, Math.min(15000, Number(message.ms) || 8000));
    var card = this.card || this.buildCard(), now = new Date().getTime();
    var live = card.shown && card.until - now > CARD_LEAVE_MS;
    if (card.id !== String(message.id) || !live) poster(card.art, message.poster);
    card.id = String(message.id);
    card.who.textContent = clip(message.who, 60);
    card.title.textContent = title;
    card.sub.textContent = clip(message.sub, 120);
    card.votes.innerHTML = '';
    var voters = message.voters && message.voters.length ? message.voters : [], i;
    for (i = 0; i < voters.length && i < 6; i++) {
      var dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;vertical-align:middle;width:2em;height:2em;line-height:2em;margin-right:0.21em;border-radius:50%;' +
        'text-align:center;font-size:0.575em;font-weight:700;color:#0B0D22';
      dot.style.background = tint(voters[i] && voters[i].tint);
      dot.textContent = clip(voters[i] && voters[i].i, 2);
      card.votes.appendChild(dot);
    }
    var count = document.createElement('span');
    var counted = Number(message.count) || voters.length;
    count.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:0.13em;font-size:0.66em;font-weight:700';
    count.style.color = counted > 1 ? '#19D8E6' : '#fff';
    count.textContent = clip(message.votes, 20);
    card.votes.appendChild(count);
    if (card.timer) { clearTimeout(card.timer); card.timer = null; }
    card.until = live ? Math.max(card.until, now + ms) : now + ms;
    if (!live) {
      card.shown = true;
      card.node.style.display = 'block';
      animating(card.node.style, true);
      prefixed(card.node.style, 'transition', 'none');
      card.node.style.opacity = '0';
      prefixed(card.node.style, 'transform', 'translateY(0.6em)');
      this.ensure();
      void card.node.offsetHeight;
      var ease = 'opacity ' + (CARD_ENTER_MS / 1000) + 's ease-out,-webkit-transform ' + (CARD_ENTER_MS / 1000) + 's ease-out,transform ' + (CARD_ENTER_MS / 1000) + 's ease-out';
      prefixed(card.node.style, 'transition', ease);
      card.node.style.opacity = '1';
      prefixed(card.node.style, 'transform', 'translateY(0)');
    } else {
      this.ensure();
    }
    var self = this;
    card.timer = setTimeout(function () { self.leaveCard(); }, card.until - now - CARD_LEAVE_MS);
  };
  Layer.prototype.leaveCard = function () {
    var card = this.card, self = this;
    if (!card || !card.shown) return;
    prefixed(card.node.style, 'transition', 'opacity ' + (CARD_LEAVE_MS / 1000) + 's ease-in');
    card.node.style.opacity = '0';
    card.timer = setTimeout(function () {
      card.timer = null;
      card.shown = false;
      card.node.style.display = 'none';
      animating(card.node.style, false);
      self.tick();
    }, CARD_LEAVE_MS);
  };
  Layer.prototype.ensure = function () {
    var self = this;
    if (!this.timer) this.timer = setInterval(function () { self.tick(); }, CHECK_MS);
    this.tick();
  };
  Layer.prototype.tick = function () {
    if (!this.lines.length && !this.reactions.length && !this.statusText && !(this.card && this.card.shown)) {
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
    this.rising.style.bottom = Math.round(height * 0.03) + 'px';
    this.rising.style.height = Math.round(height * 0.85) + 'px';
    this.risePx = height * 0.72;
  };
  Layer.prototype.hide = function () {
    if (this.shown) { this.box.style.display = 'none'; this.shown = false; }
    this.signature = '';
  };
  root.PortageWatchLines = {Layer: Layer, split: split, emojiFile: function (cps) { return hex(cps); }, emojiCandidates: candidates};
}(typeof window !== 'undefined' ? window : this));
