'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const createLan = require('../src/main/lanserver');
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(file => fs.existsSync(file));
for (const audio of [0, 1, 2, 3]) {
test(`production MKV route streams decodable local ${audio === 3 ? 'fallback from fractional audio index' : audio === 2 ? 'selected second audio track' : audio ? 'video and audio' : 'video'} through FFmpeg`, { timeout: 20000, skip: !ffmpeg }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-mkv-media-')), input = path.join(root, 'input.mkv'), output = path.join(root, 'output.mkv');
  const lan = createLan({}); t.after(() => { lan.teardown(); fs.rmSync(root, { recursive: true, force: true }); });
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), ...(audio === 2 ? ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0'] : []), '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), input], { timeout: 10000 });
  const url = await new Promise(resolve => lan.serveMkv(input, { audioTrack: audio === 3 ? 0.5 : audio === 2 ? 1 : 0 }, resolve));
  assert.ok(url, 'LAN fixture route must be admitted');
  const bytes = await new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      assert.equal(res.statusCode, 200); const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(Error('route timeout')));
  });
  assert.ok(bytes.length > 100); fs.writeFileSync(output, bytes);
  execFileSync(ffmpeg, ['-loglevel', 'error', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 10000 });
  if (audio) {
    const pcm = execFileSync(ffmpeg, ['-loglevel', 'error', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { timeout: 10000 });
    assert.ok(pcm.length > 48000, 'delivered audio must decode to at least half a second');
    assert.ok(pcm.some(byte => byte !== 0), 'delivered audio must contain a signal');
    let crossings = 0;
    // Ignore codec priming and estimate frequency from positive zero crossings.
    const begin = 4800, end = Math.min(pcm.length / 2, 43200);
    for (let i = begin + 1; i < end; i++) {
      if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++;
    }
    const frequency = crossings * 48000 / (end - begin);
    assert.ok(Math.abs(frequency - (audio === 2 ? 880 : 440)) < 10, `selected audio tone was ${frequency}Hz`);
  }
});
}
