(function (root) {
  'use strict';
  var LINE_MS = 6000, ENTER_MS = 300, LEAVE_MS = 400, RISE_MS = 3200;
  var MAX_LINES = 3, MAX_REACTIONS = 8, MAX_SEEN = 200;
  var LINE_SIZE = 0.029, EMOJI_EM = 2.15, COLUMN_WIDTH_EM = 7.3, COLUMN_HEIGHT_EM = 10, RISE_EM = 6.3, LANE_EM = 3;
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
  function detach(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }
  function blurs() {
    try {
      var css = root.CSS;
      return !!(css && css.supports && (css.supports('backdrop-filter', 'blur(1px)') || css.supports('-webkit-backdrop-filter', 'blur(1px)')));
    } catch (e) { return false; }
  }
  function Layer(options) {
    this.options = options || {};
    this.lines = []; this.reactions = []; this.seen = {}; this.seenOrder = []; this.lane = 0;
    this.timer = null; this.signature = ''; this.statusText = '';
    this.blur = this.options.blur !== false && blurs();
    fonts(this.options.fonts == null ? 'fonts/' : this.options.fonts);
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
    this.statusPill.style.background = this.blur ? 'rgba(11,13,34,0.6)' : 'rgba(11,13,34,0.8)';
    if (this.blur) { prefixed(this.statusPill.style, 'backdropFilter', 'blur(14px)'); }
    this.status.appendChild(this.statusPill);
    this.box.appendChild(this.column);
    this.box.appendChild(this.rising);
    this.box.appendChild(this.status);
    document.body.appendChild(this.box);
  }
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
    prefixed(row.style, 'transform', 'translateY(0.6em)');
    var capsule = document.createElement('span');
    capsule.style.cssText = 'display:inline-block;max-width:100%;box-sizing:border-box;padding:0.38em 0.77em;border-radius:1.08em';
    capsule.style.background = this.blur ? 'rgba(11,13,34,0.6)' : 'rgba(11,13,34,0.8)';
    if (this.blur) { prefixed(capsule.style, 'backdropFilter', 'blur(14px)'); }
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
    var lane = this.lane; this.lane = 1 - this.lane;
    var shift = lane === 1 ? 'translateX(-' + LANE_EM + 'em) ' : '';
    var node = document.createElement('div');
    node.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;text-align:center;opacity:1';
    prefixed(node.style, 'transform', shift + 'translateY(0)');
    var face = document.createElement('div');
    face.style.cssText = 'line-height:1.1';
    face.style.fontSize = EMOJI_EM + 'em';
    face.textContent = emoji;
    var label = document.createElement('div');
    label.style.cssText = 'font-size:0.75em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,0.8),0 0 3px rgba(0,0,0,0.6)';
    label.style.color = tint(message.tint);
    label.textContent = name;
    node.appendChild(face);
    node.appendChild(label);
    this.rising.appendChild(node);
    var self = this, entry = {node: node, timer: null};
    this.reactions.push(entry);
    entry.timer = setTimeout(function () { self.drop(entry); }, RISE_MS);
    this.ensure();
    void node.offsetHeight;
    var ease = 'opacity ' + (RISE_MS / 1000) + 's ease-in,-webkit-transform ' + (RISE_MS / 1000) + 's ease-in,transform ' + (RISE_MS / 1000) + 's ease-in';
    prefixed(node.style, 'transition', ease);
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
    if (!this.timer) this.timer = setInterval(function () { self.tick(); }, 250);
    this.tick();
  };
  Layer.prototype.tick = function () {
    if (!this.lines.length && !this.reactions.length && !this.statusText) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.box.style.display = 'none'; this.signature = '';
      return;
    }
    var video = this.options.video ? this.options.video() : null;
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 1) { this.box.style.display = 'none'; return; }
    var rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) { this.box.style.display = 'none'; return; }
    var scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    var width = video.videoWidth * scale, height = video.videoHeight * scale;
    var left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    var subtitle = Math.max(16, Math.min(72, height * 0.045));
    var bottom = Math.max(height * 0.05, height * 0.04 + subtitle * 1.2 * 2.6);
    var signature = left + '|' + top + '|' + width + '|' + height;
    this.box.style.display = 'block';
    if (signature === this.signature) return;
    this.signature = signature;
    this.box.style.left = left + 'px'; this.box.style.top = top + 'px';
    this.box.style.width = width + 'px'; this.box.style.height = height + 'px';
    this.box.style.fontSize = Math.max(14, height * LINE_SIZE) + 'px';
    this.column.style.bottom = bottom + 'px';
    this.rising.style.bottom = bottom + 'px';
  };
  root.PortageWatchLines = {Layer: Layer};
}(typeof window !== 'undefined' ? window : this));
