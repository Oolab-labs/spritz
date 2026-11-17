'use strict';

// The television's half of late subtitles. A torrent MP4 keeps its index (moov) at the end of the
// file, so the Mac cannot know the subtitle tracks when it sends the load without stalling the cast
// on the last pieces of the swarm. It learns them once the TV has fetched that index to start playing,
// and sends them in a `subtitles` command for the film already on screen. Measured on a 13 GB WEB-DL
// with two English mov_text tracks: before this the TV's menu said "Subtitles: Off" with nothing to
// choose, because the load had carried no list and the webOS player exposes no text tracks of its own.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'webos-receiver', 'index.html');

class FakeElement {
  constructor() { this.className = ''; this.style = {}; this.textContent = ''; this.hidden = false; this.listeners = new Map(); this.classList = { add() {}, remove() {} }; }
  addEventListener(type, fn) { const l = this.listeners.get(type) || []; l.push(fn); this.listeners.set(type, l); }
  removeEventListener() {}
  dispatch(type) { for (const fn of this.listeners.get(type) || []) fn({ type }); }
  focus() {}
}
class FakeVideo extends FakeElement {
  constructor() {
    super(); this.currentTime = 0; this.duration = NaN; this.paused = true; this.ended = false; this.seeking = false; this.readyState = 0;
    this.audioTracks = []; this.textTracks = []; this.children = [];
    this.seekable = { length: 0, start() { return 0; }, end() { return 0; } };
    this.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  querySelectorAll() { return []; }
  appendChild(node) { this.children.push(node); }
  load() {}
  canPlayType() { return 'probably'; }
}

function harness() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const source = scripts.at(-1)[1].replace(/\nconnect\(\);\s*$/, '\n');
  const video = new FakeVideo();
  const elements = new Map([['v', video]]);
  const element = (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); };
  const requests = [];
  function XMLHttpRequest() { this.open = (method, url) => { this.url = url; }; this.send = () => requests.push(this); this.abort = () => {}; }
  const context = {
    console: { log() {} }, Date, JSON, Math, Object, Promise, isFinite, URL, XMLHttpRequest,
    SpritzStartSeek: require('../webos-receiver/start-seek'),
    SpritzMediaTracks: require('../webos-receiver/media-tracks'),
    SpritzTrackMenu: require('../webos-receiver/track-menu'),
    SpritzSubtitleLoader: require('../webos-receiver/subtitle-loader'),
    screen: { width: 1920, height: 1080 }, history: { pushState() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { getElementById: element, addEventListener() {}, createElement: () => new FakeElement(), activeElement: null },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
  };
  context.window = context;
  context.window.addEventListener = () => {};
  context.window.SpritzHmac = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: INDEX });
  const sent = [];
  context.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} };
  return { context, video, sent, requests, element };
}

const LATE = [
  { id: 'source-subtitle-0', url: 'http://mac:1/rsub/tok/sub_0_eng.vtt', lang: 'eng', name: 'ENG', prepare: true },
  { id: 'source-subtitle-1', url: 'http://mac:1/rsub/tok/sub_1_eng.vtt', lang: 'eng', name: 'ENG · 2', prepare: true }
];
const lastTracks = (sent) => sent.filter((m) => m.type === 'tracks').at(-1);

test('subtitles sent after the load fill the menu of the film already playing', () => {
  const { context, sent, element } = harness();
  context.onMessage({ v: 1, type: 'load', mediaId: 'film', url: 'http://mac:1/dlna/t/film.mp4', startSec: 0 });
  assert.equal(context.media.subtitleBindings.length, 0, 'the load carried no subtitles, as a torrent MP4 load does');
  context.onMessage({ v: 1, type: 'subtitles', mediaId: 'film', epoch: null, subtitles: LATE });
  assert.deepEqual(context.media.subtitleBindings.map((b) => b.id), ['source-subtitle-0', 'source-subtitle-1']);
  assert.ok(context.media.subtitleBindings.every((b) => b.prepare === true && b.node === null), 'prepared on selection, not fetched up front');
  const report = lastTracks(sent);
  assert.ok(report, 'the TV told the Mac its tracks changed');
  assert.deepEqual(report.tracks.subtitles.map((t) => t.id), ['source-subtitle-0', 'source-subtitle-1']);
  assert.equal(element('subtitle-value').textContent, 'Off', 'nothing is switched on for the viewer');
});

test('a late subtitle list for another film, or a second list, changes nothing', () => {
  const { context, sent } = harness();
  context.onMessage({ v: 1, type: 'load', mediaId: 'film', url: 'http://mac:1/dlna/t/film.mp4', startSec: 0 });
  context.onMessage({ v: 1, type: 'subtitles', mediaId: 'previous-film', epoch: null, subtitles: LATE });
  assert.equal(context.media.subtitleBindings.length, 0, 'a list for a film that is no longer on screen is ignored');
  context.onMessage({ v: 1, type: 'subtitles', mediaId: 'film', epoch: null, subtitles: LATE.slice(0, 1) });
  const before = sent.length;
  context.onMessage({ v: 1, type: 'subtitles', mediaId: 'film', epoch: null, subtitles: LATE });
  assert.equal(context.media.subtitleBindings.length, 1, 'bindings are never rebuilt under a viewer who may already have picked one');
  assert.equal(sent.length, before);
});

test('selecting a late subtitle asks the Mac to prepare it at the play position', () => {
  const { context, video, requests } = harness();
  context.onMessage({ v: 1, type: 'load', mediaId: 'film', url: 'http://mac:1/dlna/t/film.mp4', startSec: 0 });
  context.onMessage({ v: 1, type: 'subtitles', mediaId: 'film', epoch: null, subtitles: LATE });
  video.currentTime = 2511;
  context.selectMediaTrack('subtitle', 'source-subtitle-1', true);
  const prep = requests.find((r) => /spritzSubPrepare=1/.test(r.url));
  assert.ok(prep, 'a prepare request went out');
  assert.match(prep.url, /^http:\/\/mac:1\/rsub\/tok\/sub_1_eng\.vtt\?spritzSubPrepare=1&spritzSubPosition=2511&/);
});
