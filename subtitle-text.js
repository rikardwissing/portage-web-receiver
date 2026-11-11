(function (root) {
  'use strict';
  var colours = {white:'#fff',black:'#000',red:'#f00',lime:'#0f0',green:'#0f0',blue:'#00f',yellow:'#ff0',cyan:'#0ff',magenta:'#f0f'};
  function number(value, fallback) { var n = parseFloat(value); return isFinite(n) ? n : fallback; }
  function clamp(value) { return Math.max(0, Math.min(100, value)); }
  function seconds(value) {
    var parts = value.replace(',', '.').split(':'), result = 0;
    for (var i = 0; i < parts.length; i++) result = result * 60 + number(parts[i], 0);
    return result;
  }
  function settings(value) {
    var result = {}, tokens = String(value || '').split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var parts = tokens[i].split(':');
      if (parts.length === 2 && /^(line|position|align|size|vertical)$/.test(parts[0])) result[parts[0]] = parts[1];
    }
    return result;
  }
  function parse(text) {
    var blocks = String(text).replace(/\r/g, '').split(/\n{2,}/), result = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
      for (var j = 0; j < lines.length; j++) {
        var match = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)$/.exec(lines[j]);
        if (!match) continue;
        result.push({s:seconds(match[1]),e:seconds(match[2]),text:lines.slice(j+1).join('\n'),settings:settings(match[3])});
        break;
      }
    }
    return result;
  }
  function decode(text) {
    return text.replace(/&(amp|lt|gt|nbsp|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (all, entity) {
      var names = {amp:'&',lt:'<',gt:'>',nbsp:'\u00a0',quot:'"',apos:"'"};
      if (entity.charAt(0) !== '#') return names[entity.toLowerCase()] || all;
      var code = entity.charAt(1).toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
      return code > 0 && code <= 65535 ? String.fromCharCode(code) : all;
    });
  }
  function content(parent, text) {
    var tokens = String(text).split(/(<[^>]*>)/g), stack = [parent], names = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i], tag = /^<(\/?)(b|i|u|c)(?:\.([a-z.]+))?\s*>$/i.exec(token);
      if (tag) {
        var name = tag[2].toLowerCase();
        if (tag[1]) {
          for (var k = names.length - 1; k >= 0; k--) {
            if (names[k] === name) { stack.length = k + 1; names.length = k; break; }
          }
        } else {
          var node = document.createElement(name === 'c' ? 'span' : name);
          if (name === 'c') {
            var classes = (tag[3] || '').split('.');
            for (var c = 0; c < classes.length; c++) if (colours[classes[c]]) node.style.color = colours[classes[c]];
          }
          stack[stack.length-1].appendChild(node); stack.push(node); names.push(name);
        }
      } else if (/^<br\s*\/?>$/i.test(token)) {
        stack[stack.length-1].appendChild(document.createTextNode('\n'));
      } else if (token && token.charAt(0) !== '<') {
        stack[stack.length-1].appendChild(document.createTextNode(decode(token)));
      }
    }
  }
  function fromNative(cue, original) {
    if (original) return {text:cue.text || '',settings:original};
    var set = {align:cue.align || 'center',size:String(cue.size == null ? 100 : cue.size)};
    if (typeof cue.position === 'number') set.position = cue.position + '%,' + (cue.positionAlign || 'auto');
    if (typeof cue.line === 'number') set.line = cue.line + (cue.snapToLines === false ? '%' : '') + ',' + (cue.lineAlign || (cue.snapToLines === false && cue.line > 50 ? 'end' : cue.snapToLines === false && cue.line === 50 ? 'center' : 'start'));
    if (cue.vertical) set.vertical = cue.vertical;
    return {text:cue.text || '',settings:set};
  }
  function Layer(options) {
    this.options = options; this.manual = null; this.signature = ''; this.documents = {}; this.documentCount = 0;
    this.box = document.createElement('div');
    this.box.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:999;display:none';
    document.body.appendChild(this.box);
    var self = this;
    this.timer = setInterval(function () { self.tick(); }, 100);
  }
  Layer.prototype.set = function (cues) { this.manual = cues; this.tick(); };
  Layer.prototype.original = function (video, track, cue) {
    var elements = video.querySelectorAll ? video.querySelectorAll('track') : [], source = '';
    for (var i = 0; i < elements.length; i++) if (elements[i].track === track) source = elements[i].src;
    if (!source) return null;
    var document = this.documents[source], self = this;
    if (!document && typeof XMLHttpRequest !== 'undefined') {
      if (this.documentCount >= 4) { this.documents = {}; this.documentCount = 0; }
      document = {cues:[]}; this.documents[source] = document; this.documentCount++;
      var request = new XMLHttpRequest();
      request.open('GET', source, true);
      request.onload = function () {
        if (request.status >= 200 && request.status < 300 || request.status === 0) {
          document.cues = parse(request.responseText); self.signature = ''; self.tick();
        }
      };
      request.onerror = function () {};
      try { request.send(); } catch (error) {}
    }
    var cues = document ? document.cues : [];
    for (var j = 0; j < cues.length; j++) {
      if (Math.abs(cues[j].s-cue.startTime) < 0.002 && Math.abs(cues[j].e-cue.endTime) < 0.002 && cues[j].text.replace(/\n+$/, '') === String(cue.text).replace(/\n+$/, '')) return cues[j].settings;
    }
    return null;
  };
  Layer.prototype.tick = function () {
    var video = this.options.video();
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 1) { this.box.style.display = 'none'; return; }
    var rootNode = video.getRootNode ? video.getRootNode() : document;
    if (!rootNode._portageTextStyle) {
      var style = document.createElement('style');
      style.textContent = 'video::cue{color:transparent!important;background:transparent!important;text-shadow:none!important}video::-webkit-media-text-track-container{visibility:hidden!important}video::-webkit-media-text-track-display{opacity:0!important}';
      (rootNode.head || rootNode).appendChild(style); rootNode._portageTextStyle = true;
    }
    var cues = this.manual, tracks = video.textTracks;
    if (cues === null) {
      cues = [];
      for (var i = 0; tracks && i < tracks.length; i++) {
        if (tracks[i].mode !== 'showing') continue;
        var active = tracks[i].activeCues;
        for (var j = 0; active && j < active.length; j++) cues.push(fromNative(active[j], this.original(video, tracks[i], active[j])));
      }
    }
    var rect = video.getBoundingClientRect(), scale = Math.min(rect.width/video.videoWidth, rect.height/video.videoHeight);
    var width = video.videoWidth*scale, height = video.videoHeight*scale;
    var signature = JSON.stringify(cues) + '|' + rect.left + '|' + rect.top + '|' + width + '|' + height;
    this.box.style.display = cues.length ? 'block' : 'none';
    if (signature === this.signature) return;
    this.signature = signature; this.box.textContent = '';
    this.box.style.left = (rect.left+(rect.width-width)/2)+'px'; this.box.style.top = (rect.top+(rect.height-height)/2)+'px';
    this.box.style.width = width+'px'; this.box.style.height = height+'px';
    for (var n = 0; n < cues.length; n++) this.paint(cues[n], height, n);
  };
  Layer.prototype.paint = function (cue, height, ordinal) {
    var set = typeof cue.settings === 'string' ? settings(cue.settings) : cue.settings || {};
    var align = set.align || 'center', left = align === 'start' || align === 'left', right = align === 'end' || align === 'right';
    var position = String(set.position || (left ? '4%,line-left' : right ? '96%,line-right' : '50%,center')).split(',');
    var anchor = position[1] || 'auto';
    var x = clamp(number(position[0],50)), tx = anchor === 'line-left' || anchor === 'start' ? 0 : anchor === 'line-right' || anchor === 'end' ? -100 : anchor === 'center' ? -50 : left ? 0 : right ? -100 : -50;
    var line = String(set.line == null ? 'auto' : set.line).split(','), y, ty;
    if (line[0].indexOf('%') >= 0) { y = clamp(number(line[0],95)); ty = line[1] === 'end' ? -100 : line[1] === 'center' ? -50 : 0; }
    else if (line[0] === 'auto') { y = 96 - ordinal * 7; ty = -100; }
    else { var row = number(line[0],-1); y = row < 0 ? Math.max(0,100+row*6) : Math.min(100,row*6); ty = row < 0 ? -100 : 0; }
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;white-space:pre-wrap;overflow-wrap:break-word;color:white;font-family:Arial,sans-serif;font-weight:normal;line-height:1.2;text-shadow:0 2px 3px black,0 0 2px black';
    box.style.fontSize = Math.max(16,Math.min(72,height*0.045))+'px';
    box.style.left=x+'%'; box.style.top=y+'%'; box.style.transform='translate('+tx+'%,'+ty+'%)';
    box.style.width=Math.max(1,Math.min(clamp(number(set.size,92)),tx===0?100-x:tx===-100?x:2*Math.min(x,100-x)))+'%';
    box.style.textAlign=left?'left':right?'right':'center';
    if (set.vertical === 'rl' || set.vertical === 'lr') box.style.writingMode='vertical-'+set.vertical;
    content(box,cue.text); this.box.appendChild(box);
  };
  root.PortageSubtitleText = {Layer:Layer,parse:parse,settings:settings,content:content};
}(typeof window !== 'undefined' ? window : this));
