'use strict';

// The `subtitles` command: a subtitle list for the film already loaded, sent once the Mac has
// learned it (a torrent MP4's track list sits in an index at the end of the file).

const { test } = require('node:test');
const assert = require('assert');
const proto = require('../src/main/receiver-protocol');

const SUB = { id: 'source-subtitle-0', url: 'http://mac/rsub/t/sub_0_eng.vtt', lang: 'eng', name: 'ENG', prepare: true };

test('a subtitles command round-trips and is authenticated-only', () => {
  const m = proto.subtitles('sid', { mediaId: 'm1', subtitles: [SUB] });
  assert.equal(m.type, 'subtitles');
  assert.equal(m.epoch, null);
  const r = proto.parse(proto.serialize(m));
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.msg.subtitles, [SUB]);
  assert.ok(proto.POST_AUTH_ONLY.includes('subtitles'), 'a media URL must never reach an unpaired television');
});

test('a subtitles command is held to the same rules as subtitles inside a load', () => {
  const bad = [
    { mediaId: 'm1', subtitles: [] },
    { mediaId: 'm1', subtitles: [{ ...SUB, url: 'file:///etc/passwd' }] },
    { mediaId: 'm1', subtitles: [{ ...SUB, id: 'not-an-id' }] },
    { mediaId: 'm1', subtitles: Array.from({ length: 129 }, (_, i) => ({ ...SUB, id: 'source-subtitle-' + (i % 128) })) },
    { mediaId: null, subtitles: [SUB] }
  ];
  for (const fields of bad) {
    const raw = { v: proto.PROTOCOL_VERSION, type: 'subtitles', sid: 's', t: 1, epoch: null, ...fields };
    assert.equal(proto.parse(JSON.stringify(raw)).ok, false, JSON.stringify(fields).slice(0, 80));
  }
});
