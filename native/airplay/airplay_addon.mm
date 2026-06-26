// Spritz — AirPlay-via-macOS addon (Objective-C++, ARC ON).
//
// Casts the current media to an AirPlay device through a native AVPlayer with
// external playback; an AVRoutePickerView (the system AirPlay button, overlaid on
// the DOM control-bar button) lets the user pick the device — macOS owns HAP
// pairing / FairPlay / encryption.
//
// Orchestration (route selection is UI-only on macOS, and the sheet routes a
// player that must already be bound+ready):
//   attachPicker(handle, rect)  → AVRouteDetector + AVRoutePickerView created
//   prepare(url, startSec)      → AVPlayer (paused, muted), picker.player = it
//   user clicks the picker      → willBeginPresentingRoutes → play() so it's live
//   user selects the TV         → externalPlaybackActive=YES → emit 'external' →
//                                 main stops mpv + seeks; renderer → remote mode
//   user cancels the sheet      → didEndPresentingRoutes, not external → pause

#include <napi.h>
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreMedia/CoreMedia.h>

#include <string>
#include <memory>
#include <vector>
#include <atomic>

// ---- event pump → JS (plain C++ payload; no ObjC bridging) ----
static Napi::ThreadSafeFunction gTsfn;
static std::atomic<bool> gHasTsfn{false}; // emit() (main-queue blocks/KVO) vs SetEventListener race

struct ApEv {
  std::string type;     // routes | external | status | time | ended | error
  bool   flag = false;
  int    ival = 0;
  double cur = 0, dur = 0;
  std::string msg;
};
static void EmitToJs(Napi::Env env, Napi::Function fn, ApEv* e) {
  std::unique_ptr<ApEv> ev(e);
  if (env != nullptr && fn != nullptr) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("type", e->type);
    if (e->type == "routes")        o.Set("available", Napi::Boolean::New(env, e->flag));
    else if (e->type == "external") o.Set("active", Napi::Boolean::New(env, e->flag));
    else if (e->type == "status")   o.Set("value", Napi::Number::New(env, e->ival));
    else if (e->type == "time") { o.Set("cur", Napi::Number::New(env, e->cur)); o.Set("dur", Napi::Number::New(env, e->dur)); }
    else if (e->type == "error") { o.Set("code", Napi::Number::New(env, e->ival)); o.Set("message", Napi::String::New(env, e->msg)); }
    try { fn.Call({ o }); } catch (const Napi::Error& err) { NSLog(@"[airplay] listener threw: %s", err.what()); }
  }
}
static void emit(ApEv* e) {
  if (gHasTsfn) { if (gTsfn.NonBlockingCall(e, EmitToJs) != napi_ok) delete e; }
  else delete e;
}

// ---- AVFoundation singletons (ARC strong) ----
static AVPlayer*          gPlayer = nil;
static AVRoutePickerView* gPicker = nil;
static AVRouteDetector*   gDetector = nil;
static NSView*            gContent = nil;
static id                 gTimeObs = nil;
static id                 gEndObs = nil;
static id                 gFailObs = nil;
static AVPlayerItem*      gObservedItem = nil; // the EXACT item the "status" KVO is registered on (balanced removal)

static void teardownPlayer();

@interface ApObserver : NSObject <AVRoutePickerViewDelegate>
@end
@implementation ApObserver
- (void)observeValueForKeyPath:(NSString*)kp ofObject:(id)obj
                        change:(NSDictionary*)ch context:(void*)ctx {
  if ([kp isEqualToString:@"externalPlaybackActive"]) {
    BOOL active = gPlayer.externalPlaybackActive;
    if (active) gPlayer.muted = NO; // audio now goes to the TV
    ApEv* e = new ApEv(); e->type = "external"; e->flag = active; emit(e);
  } else if ([kp isEqualToString:@"status"]) {
    ApEv* e = new ApEv(); e->type = "status"; e->ival = (int)gPlayer.currentItem.status;
    if (gPlayer.currentItem.status == AVPlayerItemStatusFailed && gPlayer.currentItem.error)
      e->msg = std::string([gPlayer.currentItem.error.localizedDescription UTF8String]);
    emit(e);
  } else if ([kp isEqualToString:@"multipleRoutesDetected"]) {
    ApEv* e = new ApEv(); e->type = "routes"; e->flag = gDetector.multipleRoutesDetected; emit(e);
  }
}
// the picker opened → only NOW allow external playback (so a prepared player never
// auto-grabs a still-selected/sticky route) and play so route-select engages external
- (void)routePickerViewWillBeginPresentingRoutes:(AVRoutePickerView*)v {
  if (gPlayer) { gPlayer.allowsExternalPlayback = YES; [gPlayer play]; }
}
// the sheet closed → if no route was taken, revoke external again and pause (user cancelled)
- (void)routePickerViewDidEndPresentingRoutes:(AVRoutePickerView*)v {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.9 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (gPlayer && !gPlayer.externalPlaybackActive) { gPlayer.allowsExternalPlayback = NO; [gPlayer pause]; }
  });
}
@end
static ApObserver* gObserver = nil;

static void RunOnMain(void (^block)(void)) {
  if ([NSThread isMainThread]) block(); else dispatch_sync(dispatch_get_main_queue(), block);
}
static void teardownPlayer() {
  if (gTimeObs) { [gPlayer removeTimeObserver:gTimeObs]; gTimeObs = nil; }
  if (gEndObs)  { [[NSNotificationCenter defaultCenter] removeObserver:gEndObs]; gEndObs = nil; }
  if (gFailObs) { [[NSNotificationCenter defaultCenter] removeObserver:gFailObs]; gFailObs = nil; }
  if (gPlayer) {
    @try { [gPlayer removeObserver:gObserver forKeyPath:@"externalPlaybackActive"]; } @catch (...) {}
    // Remove the "status" observer from the EXACT item it was registered on — NOT gPlayer.currentItem,
    // which the replaceCurrentItemWithPlayerItem:nil below nils out (leaving the observer leaked/imbalanced).
    if (gObservedItem) { @try { [gObservedItem removeObserver:gObserver forKeyPath:@"status"]; } @catch (...) {} gObservedItem = nil; }
    // End the external (AirPlay) session, not just our player — otherwise the system
    // route stays selected, the TV stays on the AirPlay screen, and the next prepare()
    // binds to an already-connected route that never fires a fresh externalPlaybackActive
    // transition (the "second cast shows already-connected but won't engage" bug).
    // Order matters: revoke external + empty the player (nothing left to route), THEN
    // unbind the picker, so the route actually drops instead of clinging to a live item.
    gPlayer.allowsExternalPlayback = NO;
    [gPlayer pause];
    @try { [gPlayer replaceCurrentItemWithPlayerItem:nil]; } @catch (...) {} // empty player → route has nothing to hold
  }
  if (gPicker) gPicker.player = nil;
  gPlayer = nil;
}

static NSView* viewFromHandle(const Napi::CallbackInfo& info, int idx) {
  return (__bridge NSView*)(*reinterpret_cast<void**>(info[idx].As<Napi::Buffer<char>>().Data()));
}
static NSRect flipRect(NSView* content, double x, double y, double w, double h) {
  return NSMakeRect(x, content.bounds.size.height - y - h, w, h); // DOM top-left → AppKit bottom-left
}

Napi::Value SetEventListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) { Napi::TypeError::New(env, "expected a function").ThrowAsJavaScriptException(); return env.Undefined(); }
  if (gHasTsfn) { gTsfn.Release(); gHasTsfn = false; }
  gTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "airplayEvents", 0, 1);
  gHasTsfn = true;
  if (!gObserver) gObserver = [[ApObserver alloc] init];
  return env.Undefined();
}

// attachPicker(handle, x, y, w, h) — create the route detector + the overlaid picker.
Napi::Value AttachPicker(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "expected (handle,x,y,w,h)").ThrowAsJavaScriptException(); return env.Undefined(); }
  NSView* content = viewFromHandle(info, 0);
  double x = info[1].As<Napi::Number>().DoubleValue(), y = info[2].As<Napi::Number>().DoubleValue();
  double w = info[3].As<Napi::Number>().DoubleValue(), h = info[4].As<Napi::Number>().DoubleValue();
  if (!content) { Napi::Error::New(env, "null NSView").ThrowAsJavaScriptException(); return env.Undefined(); }
  RunOnMain(^{
    gContent = content;
    if (!gDetector) {
      gDetector = [[AVRouteDetector alloc] init];
      gDetector.routeDetectionEnabled = YES;
      [gDetector addObserver:gObserver forKeyPath:@"multipleRoutesDetected" options:NSKeyValueObservingOptionInitial context:nil];
    }
    if (!gPicker) {
      gPicker = [[AVRoutePickerView alloc] initWithFrame:flipRect(content, x, y, w, h)];
      gPicker.delegate = gObserver;
      [gPicker setRoutePickerButtonColor:[NSColor whiteColor] forState:AVRoutePickerViewButtonStateNormal];
      gPicker.hidden = YES; // shown via updatePickerRect when the control-bar button is visible
      [content addSubview:gPicker positioned:NSWindowAbove relativeTo:nil];
    } else {
      gPicker.frame = flipRect(content, x, y, w, h);
    }
  });
  return env.Undefined();
}

// updatePickerRect(x, y, w, h, visible) — reposition (or park offscreen when hidden).
Napi::Value UpdatePickerRect(const Napi::CallbackInfo& info) {
  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) return info.Env().Undefined();
  double x = info[0].As<Napi::Number>().DoubleValue(), y = info[1].As<Napi::Number>().DoubleValue();
  double w = info[2].As<Napi::Number>().DoubleValue(), h = info[3].As<Napi::Number>().DoubleValue();
  bool visible = info.Length() > 4 ? info[4].As<Napi::Boolean>().Value() : true;
  RunOnMain(^{
    if (!gPicker || !gContent) return;
    gPicker.hidden = !visible;
    if (visible) gPicker.frame = flipRect(gContent, x, y, w, h);
  });
  return info.Env().Undefined();
}

// prepare(url, startSec) — create the AVPlayer (paused, muted) bound to the picker.
Napi::Value Prepare(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) { Napi::TypeError::New(env, "prepare expects (url[,startSec])").ThrowAsJavaScriptException(); return env.Undefined(); }
  std::string urlStr = info[0].As<Napi::String>().Utf8Value();
  double startSec = (info.Length() > 1 && info[1].IsNumber()) ? info[1].As<Napi::Number>().DoubleValue() : 0;
  NSURL* url = [NSURL URLWithString:[NSString stringWithUTF8String:urlStr.c_str()]];
  if (!url) { Napi::Error::New(env, "bad url").ThrowAsJavaScriptException(); return env.Undefined(); }
  RunOnMain(^{
    teardownPlayer();
    AVPlayerItem* item = [AVPlayerItem playerItemWithURL:url];
    gPlayer = [AVPlayer playerWithPlayerItem:item];
    gPlayer.allowsExternalPlayback = NO; // do NOT auto-grab a sticky route; enabled when the picker opens
    gPlayer.muted = YES; // silent until it's actually on the TV
    if (gPicker) gPicker.player = gPlayer;
    [gPlayer addObserver:gObserver forKeyPath:@"externalPlaybackActive" options:NSKeyValueObservingOptionNew context:nil];
    [item addObserver:gObserver forKeyPath:@"status" options:NSKeyValueObservingOptionNew context:nil];
    gObservedItem = item; // remember the precise item so teardown removes the observer from it (not a nil'd currentItem)
    gTimeObs = [gPlayer addPeriodicTimeObserverForInterval:CMTimeMakeWithSeconds(0.5, 600) queue:dispatch_get_main_queue() usingBlock:^(CMTime t) {
      ApEv* e = new ApEv(); e->type = "time"; e->cur = CMTimeGetSeconds(t);
      CMTime d = gPlayer.currentItem.duration; e->dur = (CMTIME_IS_INDEFINITE(d) || CMTIME_IS_INVALID(d)) ? 0 : CMTimeGetSeconds(d);
      emit(e);
    }];
    gEndObs = [[NSNotificationCenter defaultCenter] addObserverForName:AVPlayerItemDidPlayToEndTimeNotification object:item queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification* n) { ApEv* e = new ApEv(); e->type = "ended"; emit(e); }];
    gFailObs = [[NSNotificationCenter defaultCenter] addObserverForName:AVPlayerItemFailedToPlayToEndTimeNotification object:item queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification* n) {
      NSError* err = n.userInfo[AVPlayerItemFailedToPlayToEndTimeErrorKey];
      ApEv* e = new ApEv(); e->type = "error"; e->ival = (int)err.code; e->msg = err.localizedDescription ? std::string([err.localizedDescription UTF8String]) : "playback failed"; emit(e);
    }];
    if (startSec > 0) [gPlayer seekToTime:CMTimeMakeWithSeconds(startSec, 600) toleranceBefore:kCMTimeZero toleranceAfter:kCMTimeZero];
  });
  return env.Undefined();
}

Napi::Value Play(const Napi::CallbackInfo& info)  { RunOnMain(^{ [gPlayer play]; }); return info.Env().Undefined(); }
Napi::Value Pause(const Napi::CallbackInfo& info) { RunOnMain(^{ [gPlayer pause]; }); return info.Env().Undefined(); }
Napi::Value Seek(const Napi::CallbackInfo& info)  {
  if (info.Length() < 1 || !info[0].IsNumber()) return info.Env().Undefined();
  double t = info[0].As<Napi::Number>().DoubleValue();
  RunOnMain(^{ [gPlayer seekToTime:CMTimeMakeWithSeconds(t, 600) toleranceBefore:kCMTimeZero toleranceAfter:kCMTimeZero]; });
  return info.Env().Undefined();
}
Napi::Value SetVolume(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) return info.Env().Undefined();
  float v = (float)info[0].As<Napi::Number>().DoubleValue();
  RunOnMain(^{ gPlayer.volume = v; gPlayer.muted = NO; });
  return info.Env().Undefined();
}

Napi::Value Stat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  __block bool ext = false, routes = false; __block double cur = 0, dur = 0, rate = 0; __block int status = 0;
  RunOnMain(^{
    if (gPlayer) {
      ext = gPlayer.externalPlaybackActive; rate = gPlayer.rate; cur = CMTimeGetSeconds(gPlayer.currentTime);
      CMTime d = gPlayer.currentItem.duration; dur = (CMTIME_IS_INDEFINITE(d) || CMTIME_IS_INVALID(d)) ? 0 : CMTimeGetSeconds(d);
      status = (int)gPlayer.currentItem.status;
    }
    if (gDetector) routes = gDetector.multipleRoutesDetected;
  });
  Napi::Object o = Napi::Object::New(env);
  o.Set("externalActive", Napi::Boolean::New(env, ext)); o.Set("rate", Napi::Number::New(env, rate));
  o.Set("cur", Napi::Number::New(env, cur)); o.Set("dur", Napi::Number::New(env, dur));
  o.Set("status", Napi::Number::New(env, status)); o.Set("routesAvailable", Napi::Boolean::New(env, routes));
  return o;
}

// --- media selection (audio / subtitle tracks on the casting AVPlayerItem) ---
// AVPlayer exposes tracks as AVMediaSelectionGroups, separate from mpv's aid/sid; these
// let the user switch audio language / subtitles WHILE the file is playing on the TV.

// mediaTracks() → { audio:[{name,selected}], subs:[{name,selected}] } (empty until status ready)
Napi::Value MediaTracks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  struct Opt { std::string name; bool selected; };
  __block std::vector<Opt> audio, subs;
  RunOnMain(^{
    if (!gPlayer || !gPlayer.currentItem) return;
    AVPlayerItem* item = gPlayer.currentItem;
    void (^collect)(NSString*, std::vector<Opt>*) = ^(NSString* ch, std::vector<Opt>* out) {
      AVMediaSelectionGroup* g = [item.asset mediaSelectionGroupForMediaCharacteristic:ch];
      if (!g) return;
      AVMediaSelectionOption* cur = [item selectedMediaOptionInMediaSelectionGroup:g];
      for (AVMediaSelectionOption* opt in g.options) {
        Opt o; o.name = opt.displayName ? std::string([opt.displayName UTF8String]) : "Track";
        o.selected = (opt == cur); out->push_back(o);
      }
    };
    collect(AVMediaCharacteristicAudible, &audio);
    collect(AVMediaCharacteristicLegible, &subs);
  });
  Napi::Object o = Napi::Object::New(env);
  auto build = [&](std::vector<Opt>& v) {
    Napi::Array a = Napi::Array::New(env, v.size());
    for (size_t i = 0; i < v.size(); i++) {
      Napi::Object e = Napi::Object::New(env);
      e.Set("name", Napi::String::New(env, v[i].name));
      e.Set("selected", Napi::Boolean::New(env, v[i].selected));
      a.Set((uint32_t)i, e);
    }
    return a;
  };
  o.Set("audio", build(audio));
  o.Set("subs", build(subs));
  return o;
}

// selectMedia(kind, index) — kind = "audio" | "subs"; index = option index, or -1 = off (subs)
Napi::Value SelectMedia(const Napi::CallbackInfo& info) {
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) return info.Env().Undefined();
  std::string kind = info[0].As<Napi::String>().Utf8Value();
  int idx = info[1].As<Napi::Number>().Int32Value();
  bool isSubs = (kind == "subs");
  RunOnMain(^{
    if (!gPlayer || !gPlayer.currentItem) return;
    AVPlayerItem* item = gPlayer.currentItem;
    NSString* ch = isSubs ? AVMediaCharacteristicLegible : AVMediaCharacteristicAudible;
    AVMediaSelectionGroup* g = [item.asset mediaSelectionGroupForMediaCharacteristic:ch];
    if (!g) return;
    if (idx < 0) { [item selectMediaOption:nil inMediaSelectionGroup:g]; return; } // subtitles off
    if (idx < (int)g.options.count) [item selectMediaOption:g.options[(NSUInteger)idx] inMediaSelectionGroup:g];
  });
  return info.Env().Undefined();
}

// stopAirplay — tear down the AVPlayer (keep picker/detector for next time).
Napi::Value StopAirplay(const Napi::CallbackInfo& info) { RunOnMain(^{ teardownPlayer(); }); return info.Env().Undefined(); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setEventListener", Napi::Function::New(env, SetEventListener));
  exports.Set("attachPicker", Napi::Function::New(env, AttachPicker));
  exports.Set("updatePickerRect", Napi::Function::New(env, UpdatePickerRect));
  exports.Set("prepare", Napi::Function::New(env, Prepare));
  exports.Set("play", Napi::Function::New(env, Play));
  exports.Set("pause", Napi::Function::New(env, Pause));
  exports.Set("seek", Napi::Function::New(env, Seek));
  exports.Set("setVolume", Napi::Function::New(env, SetVolume));
  exports.Set("stat", Napi::Function::New(env, Stat));
  exports.Set("mediaTracks", Napi::Function::New(env, MediaTracks));
  exports.Set("selectMedia", Napi::Function::New(env, SelectMedia));
  exports.Set("stopAirplay", Napi::Function::New(env, StopAirplay));
  return exports;
}
NODE_API_MODULE(airplay, Init)
