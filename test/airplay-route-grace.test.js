'use strict';
/* AirPlay picker-close handling (native/airplay/airplay_addon.mm).
 * Reproduced (2026-10-08) by compiling the shipped delegate method against a mock player:
 *  - it revoked external playback and paused 0.9s after the picker closed, killing a slow
 *    (webOS AirPlay-2) handshake that had not yet set externalPlaybackActive;
 *  - its deferred block read the global gPlayer, so an old picker close paused a newly prepared
 *    player.
 * AVKit's didEnd callback only means "the sheet closed", never "the user cancelled".
 * The ROUTE-GRACE block is compiled here, unchanged, against a mock player and virtual clock. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const mm = fs.readFileSync(path.join(__dirname, '../native/airplay/airplay_addon.mm'), 'utf8');
const begin = mm.indexOf('// ROUTE-GRACE-BEGIN'), end = mm.indexOf('// ROUTE-GRACE-END');

test('picker delegate, prepare and stop route through the generation-bound grace', () => {
  assert.ok(begin > 0 && end > begin, 'ROUTE-GRACE block missing');
  const delegate = mm.slice(mm.indexOf('@implementation ApObserver'), mm.indexOf('@end', mm.indexOf('@implementation ApObserver')));
  assert.match(delegate, /routePickerViewWillBeginPresentingRoutes[^}]*routePickerWillBegin\(\)/);
  assert.match(delegate, /routePickerViewDidEndPresentingRoutes[^}]*routePickerDidEnd\(\)/);
  assert.doesNotMatch(delegate, /dispatch_after/, 'no ungated deferred work in the delegate');
  const teardown = mm.slice(mm.indexOf('static void teardownPlayer() {'), mm.indexOf('static NSView* viewFromHandle'));
  assert.match(teardown, /retireRouteWork\(\)/, 'prepare/stop must retire pending route work');
});

const clang = (() => { try { return execFileSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' }).trim(); } catch (e) { return null; } })();
test('grace behaviour against a mock player', { skip: process.platform !== 'darwin' || !clang ? 'needs macOS clang' : false }, () => {
  assert.ok(begin > 0 && end > begin, 'ROUTE-GRACE block missing');
  const region = mm.slice(begin, end);
  const harness = `#import <Foundation/Foundation.h>
@interface MockPlayer : NSObject
@property BOOL externalPlaybackActive; @property BOOL allowsExternalPlayback; @property BOOL paused;
- (void)pause; - (void)play;
@end
@implementation MockPlayer
- (void)pause { self.paused = YES; } - (void)play { self.paused = NO; }
@end
#define AVPlayer MockPlayer
static MockPlayer* gPlayer;
static double vnow = 0; static NSMutableArray* q;
static void RouteAfter(double sec, dispatch_block_t b) { [q addObject:@[@(vnow + sec), [b copy]]]; }
static void runUntil(double t) {
  for (;;) {
    NSUInteger best = NSNotFound; double at = 0;
    for (NSUInteger i = 0; i < q.count; i++) { double a = [q[i][0] doubleValue]; if (a <= t && (best == NSNotFound || a < at)) { best = i; at = a; } }
    if (best == NSNotFound) break;
    dispatch_block_t b = q[best][1]; [q removeObjectAtIndex:best]; vnow = at; b();
  }
  vnow = t;
}
${region}
static MockPlayer* fresh(void) { MockPlayer* p = [MockPlayer new]; p.paused = YES; return p; }
static void reset(void) { q = [NSMutableArray new]; vnow = 0; retireRouteWork(); gPlayer = fresh(); }
int main(void) { @autoreleasepool {
  NSMutableDictionary* r = [NSMutableDictionary new];
  reset(); routePickerWillBegin(); routePickerDidEnd(); runUntil(3); gPlayer.externalPlaybackActive = YES; runUntil(30);
  r[@"slowHandshakeKept"] = @(gPlayer.allowsExternalPlayback && !gPlayer.paused);
  reset(); routePickerWillBegin(); routePickerDidEnd(); runUntil(5);
  r[@"cancelNotRevokedEarly"] = @(gPlayer.allowsExternalPlayback);
  runUntil(30); r[@"cancelRevokedAfterGrace"] = @(!gPlayer.allowsExternalPlayback && gPlayer.paused);
  r[@"pendingAfterGrace"] = @(q.count);
  reset(); routePickerWillBegin(); routePickerDidEnd(); runUntil(1);
  retireRouteWork(); gPlayer = fresh(); routePickerWillBegin(); MockPlayer* next = gPlayer; runUntil(30);
  r[@"stalePickerCloseSparesNewPlayer"] = @(next.allowsExternalPlayback && !next.paused);
  reset(); routePickerWillBegin(); routePickerDidEnd(); runUntil(2); routePickerWillBegin(); runUntil(30);
  r[@"reopenedPickerNotRevoked"] = @(gPlayer.allowsExternalPlayback && !gPlayer.paused);
  reset(); routePickerWillBegin(); routePickerDidEnd(); runUntil(1); retireRouteWork(); gPlayer = nil; runUntil(30);
  r[@"stopLeavesNoWork"] = @(q.count);
  puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:r options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
} return 0; }
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-route-grace-'));
  try {
    fs.writeFileSync(path.join(dir, 'h.m'), harness);
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-o', path.join(dir, 'h'), path.join(dir, 'h.m')], { stdio: 'pipe' });
    const r = JSON.parse(execFileSync(path.join(dir, 'h'), { encoding: 'utf8' }));
    assert.equal(Boolean(r.slowHandshakeKept), true, 'a route that connects within the grace must not be revoked');
    assert.equal(Boolean(r.cancelNotRevokedEarly), true, 'no revoke at 5s: still within the connection grace');
    assert.equal(Boolean(r.cancelRevokedAfterGrace), true, 'a picker closed with no route is revoked after the grace');
    assert.equal(r.pendingAfterGrace, 0, 'grace polling is bounded');
    assert.equal(Boolean(r.stalePickerCloseSparesNewPlayer), true, 'an old close must not pause a newly prepared player');
    assert.equal(Boolean(r.reopenedPickerNotRevoked), true, 'reopening the picker retires the previous close');
    assert.equal(r.stopLeavesNoWork, 0, 'stop retires pending route work');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
