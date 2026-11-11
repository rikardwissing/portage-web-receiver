(function (root) {
  'use strict';
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function Overlay(options) {
    this.options = options;
    this.tracks = {};
    this.active = -1;
    this.generation = 0;
    this.manifest = null;
    this.pending = false;
    this.retryAt = 0;
    this.failures = 0;
    this.images = {};
    this.bytes = 0;
    this.imageRetryAt = 0;
    this.requiredKeys = {};
    this.lastTime = null;
    this.signature = '';
    this.box = document.createElement('div');
    this.box.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:1000;display:none';
    document.body.appendChild(this.box);
    var self = this;
    this.timer = setInterval(function () { self.tick(); }, 100);
  }
  Overlay.prototype.load = function (tracks, selected) {
    this.clear();
    this.tracks = {};
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (typeof track.typeIndex === 'number' && typeof track.pictureBase === 'string') this.tracks[track.typeIndex] = track;
    }
    this.select(selected);
  };
  Overlay.prototype.select = function (index) {
    if (this.active !== index) this.clear();
    this.active = typeof index === 'number' ? index : -1;
    this.tick();
    return !!this.tracks[this.active];
  };
  Overlay.prototype.clear = function () {
    this.generation++;
    this.manifest = null;
    this.pending = false;
    this.imageRetryAt = 0;
    this.requiredKeys = {};
    this.lastTime = null;
    this.retryAt = 0;
    this.failures = 0;
    this.signature = '';
    this.active = -1;
    for (var key in this.images) this.release(key);
    this.box.textContent = '';
    this.box.style.display = 'none';
  };
  Overlay.prototype.release = function (key) {
    var entry = this.images[key];
    if (!entry) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    this.bytes -= entry.bytes;
    delete this.images[key];
  };
  Overlay.prototype.destroy = function () {
    this.clear();
    clearInterval(this.timer);
    if (this.box.parentNode) this.box.parentNode.removeChild(this.box);
  };
  Overlay.prototype.problem = function (message) {
    this.failures++;
    this.retryAt = Date.now() + Math.min(5000, this.failures * 1000);
    if (this.failures === 3 && this.options.error) this.options.error(message);
  };
  Overlay.prototype.read = function (now) {
    if (this.pending || Date.now() < this.retryAt) return;
    var self = this, generation = this.generation, track = this.tracks[this.active];
    this.pending = true;
    this.options.read(track.pictureBase + track.typeIndex + '/' + Math.floor(now * 1000) + '.json', 'json')
      .then(function (manifest) {
        if (generation !== self.generation) return;
        self.pending = false;
        if (!manifest || manifest.version !== 1 || manifest.typeIndex !== self.active ||
            !finite(manifest.from) || !finite(manifest.until) || manifest.until < manifest.from ||
            manifest.until - manifest.from > 91 || !Array.isArray(manifest.cues)) {
          throw new Error('Invalid subtitle picture window');
        }
        self.manifest = manifest;
        self.retryAt = Date.now() + (manifest.until <= now ? 500 : 1000);
        if (manifest.until > now) self.failures = 0;
        self.tick();
      }).catch(function () {
        if (generation !== self.generation) return;
        self.pending = false;
        self.problem("Couldn't load the selected subtitles on this screen.");
      });
  };
  Overlay.prototype.acquire = function (picture, now, required) {
    var self = this, key = picture.url, entry = this.images[key];
    if (entry) { entry.used = now; return entry.image; }
    if (Date.now() < this.imageRetryAt) return null;
    if (typeof key !== 'string' || !/^image\/[a-f0-9]+\.png$/.test(key) ||
        !finite(picture.width) || !finite(picture.height) || picture.width <= 0 || picture.height <= 0 ||
        !finite(picture.canvasWidth) || !finite(picture.canvasHeight) || picture.canvasWidth <= 0 || picture.canvasHeight <= 0 ||
        !finite(picture.x) || !finite(picture.y)) return null;
    var bytes = picture.width * picture.height * 4;
    if (bytes > 64 * 1024 * 1024) {
      if (required) this.problem('This subtitle picture is too large for this screen.');
      return null;
    }
    var keys = Object.keys(this.images);
    keys.sort(function (a, b) { return self.images[a].used - self.images[b].used; });
    while ((this.bytes + bytes > 64 * 1024 * 1024 || Object.keys(this.images).length >= 24) && keys.length) {
      var oldest = keys.shift();
      if (!this.requiredKeys[oldest] && (required || this.images[oldest].used < now - 1)) this.release(oldest);
    }
    if (this.bytes + bytes > 64 * 1024 * 1024 || Object.keys(this.images).length >= 24) {
      if (required) this.problem('These subtitle pictures are too large for this screen.');
      return null;
    }
    entry = {bytes:bytes, used:now, image:null, url:null};
    this.images[key] = entry;
    this.bytes += bytes;
    var generation = this.generation, base = this.tracks[this.active].pictureBase;
    this.options.read(base + key, 'image').then(function (data) {
      if (generation !== self.generation || self.images[key] !== entry) return;
      var blob = data instanceof Blob ? data : new Blob([data], {type:'image/png'});
      var url = URL.createObjectURL(blob), image = new Image();
      entry.url = url;
      image.onload = function () {
        if (generation !== self.generation || self.images[key] !== entry) { URL.revokeObjectURL(url); return; }
        entry.image = image;
        self.signature = '';
        self.tick();
      };
      image.onerror = function () {
        if (generation !== self.generation || self.images[key] !== entry) return;
        self.release(key);
        self.imageRetryAt = Date.now() + 1000;
        self.problem("Couldn't draw the selected subtitles on this screen.");
      };
      image.src = url;
    }).catch(function () {
      if (generation !== self.generation || self.images[key] !== entry) return;
      self.release(key);
      self.imageRetryAt = Date.now() + 1000;
      self.problem("Couldn't load the selected subtitles on this screen.");
    });
    return null;
  };
  Overlay.prototype.tick = function () {
    var track = this.tracks[this.active], video = this.options.video();
    if (!track || !video || !finite(video.currentTime)) { this.box.style.display = 'none'; return; }
    var now = video.currentTime + (this.options.offset ? this.options.offset() : 0);
    if (!finite(now) || now < 0) return;
    if (this.lastTime !== null && Math.abs(now - this.lastTime) > 2) {
      var selected = this.active;
      this.clear(); this.active = selected;
    }
    this.lastTime = now;
    var manifest = this.manifest;
    if (!manifest || now < manifest.from || now + 12 >= manifest.until) this.read(now);
    var active = [], future = [];
    if (manifest && now >= manifest.from && now < manifest.until) {
      for (var i = 0; i < manifest.cues.length; i++) {
        var cue = manifest.cues[i];
        if (!finite(cue.start) || !finite(cue.end) || cue.end <= cue.start) continue;
        if (cue.start <= now && now < cue.end) active.push(cue);
        else if (cue.start > now && cue.start < now + 8) future.push(cue);
      }
    }
    this.requiredKeys = {};
    for (var a = 0; a < active.length; a++) {
      var required = active[a].pictures || [];
      for (var b = 0; b < required.length; b++) this.requiredKeys[required[b].url] = true;
    }
    var shown = [], texts = [];
    for (var j = 0; j < active.length; j++) {
      var pictures = active[j].pictures || [];
      for (var p = 0; p < pictures.length; p++) {
        var image = this.acquire(pictures[p], now, true);
        if (image) shown.push({picture:pictures[p], image:image});
      }
      texts = texts.concat(active[j].text || []);
    }
    for (var k = 0; k < future.length; k++) {
      var ahead = future[k].pictures || [];
      for (var q = 0; q < ahead.length; q++) this.acquire(ahead[q], now, false);
    }
    for (var key in this.images) if (this.images[key].used < now - 10) this.release(key);
    this.paint(video, shown, texts);
  };
  Overlay.prototype.paint = function (video, shown, texts) {
    var bounds = video.getBoundingClientRect();
    if (!(video.videoWidth > 0 && video.videoHeight > 0 && bounds.width > 0 && bounds.height > 0)) return;
    var scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    var width = video.videoWidth * scale, height = video.videoHeight * scale;
    var left = bounds.left + (bounds.width - width) / 2, top = bounds.top + (bounds.height - height) / 2;
    var signature = JSON.stringify([left,top,width,height,shown.map(function (item) {return item.picture;}),texts]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.box.textContent = '';
    this.box.style.display = shown.length || texts.length ? 'block' : 'none';
    this.box.style.left = left + 'px'; this.box.style.top = top + 'px';
    this.box.style.width = width + 'px'; this.box.style.height = height + 'px';
    for (var i = 0; i < shown.length; i++) {
      var item = shown[i], picture = item.picture;
      var fitting = Math.min(width / picture.canvasWidth, height / picture.canvasHeight);
      var w = picture.width * fitting, h = picture.height * fitting;
      var x = Math.max(0, Math.min(width - w, width / 2 + (picture.x - picture.canvasWidth / 2) * fitting));
      var y = picture.y + picture.height / 2 > picture.canvasHeight / 2
        ? height - (picture.canvasHeight - picture.y) * fitting : picture.y * fitting;
      y = Math.max(0, Math.min(height - h, y));
      var node = item.image.cloneNode(false);
      node.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
      this.box.appendChild(node);
    }
    for (var j = 0; j < texts.length; j++) {
      var text = texts[j];
      if (typeof text.text !== 'string' || !finite(text.x) || !finite(text.y)) continue;
      var span = document.createElement('span');
      var dx = text.horizontal === 'left' ? 0 : text.horizontal === 'right' ? -100 : -50;
      var dy = text.vertical === 'top' ? 0 : text.vertical === 'bottom' ? -100 : -50;
      span.textContent = text.text;
      span.style.cssText = 'position:absolute;white-space:pre-wrap;color:white;font-family:sans-serif;max-width:90%;' +
        'text-shadow:0 1px 3px black,1px 0 3px black,-1px 0 3px black;line-height:1.2;text-align:' +
        (text.horizontal === 'left' ? 'left' : text.horizontal === 'right' ? 'right' : 'center') + ';font-size:' +
        Math.max(14,height * 0.04) + 'px;left:' + (text.x * 100) + '%;top:' + (text.y * 100) +
        '%;transform:translate(' + dx + '%,' + dy + '%)';
      this.box.appendChild(span);
    }
  };
  root.PortageSubtitlePictures = Overlay;
  if (typeof module !== 'undefined' && module.exports) module.exports = Overlay;
})(typeof window !== 'undefined' ? window : this);
