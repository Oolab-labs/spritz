'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {completedPlaylist}=require('../src/main/receiver-hls-finalize');
const text='#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000,\nseg0.m4s\n#EXTINF:1.968,\nseg1.m4s\n';
test('clean, complete receiver presentation adds only ENDLIST',()=>{
  assert.equal(completedPlaylist(text,4.021,0,null),text+'#EXT-X-ENDLIST\n');
  assert.equal(completedPlaylist(text+'#EXT-X-ENDLIST\n',4.021,0,null),null);
});
test('failed, killed, unknown and truncated productions cannot advertise completion',()=>{
  for(const [duration,code,signal] of [[4.021,1,null],[4.021,0,'SIGTERM'],[4.021,null,null],[NaN,0,null],[0,0,null],[60,0,null],[1,0,null]])
    assert.equal(completedPlaylist(text,duration,code,signal),null);
});
test('unfinished segment entries and nonmedia playlists cannot advertise completion',()=>{
  for(const body of [text+'#EXTINF:2.000,\n',text.replace('seg1.m4s','#comment'),text.replace('1.968','bad'),text.replace('EVENT','VOD')])
    assert.equal(completedPlaylist(body,4.021,0,null),null);
});
