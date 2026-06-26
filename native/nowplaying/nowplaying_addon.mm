// Now Playing + media keys (macOS MediaPlayer framework, ARC ON).
//   setInfo({title,duration,elapsed,rate}) → MPNowPlayingInfoCenter (Control Center / lock screen)
//   setEventListener(fn) → MPRemoteCommandCenter remote commands (hardware media keys, AirPods,
//                          Control Center buttons) delivered to JS as {cmd, value}
//
// Setting nowPlayingInfo + a playing state makes Spritz the system "Now Playing" app, which is
// what routes the F8/play-pause key and headphone controls to these command handlers.

#include <napi.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <MediaPlayer/MediaPlayer.h>
#include <string>
#include <atomic>

static Napi::ThreadSafeFunction gTsfn;
static std::atomic<bool> gHasTsfn{false}; // read by main-queue command handlers, set by SetEventListener

static void emitCmd(const char* cmd, double value) {
  if (!gHasTsfn) return;
  std::string c = cmd; double v = value;
  gTsfn.NonBlockingCall([c, v](Napi::Env env, Napi::Function fn) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("cmd", Napi::String::New(env, c));
    if (v >= 0) o.Set("value", Napi::Number::New(env, v));
    fn.Call({ o });
  });
}

Napi::Value SetEventListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) { Napi::TypeError::New(env, "expected a function").ThrowAsJavaScriptException(); return env.Undefined(); }
  if (gHasTsfn) { gTsfn.Release(); gHasTsfn = false; }
  gTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "nowplaying", 0, 1);
  gHasTsfn = true;

  static bool registered = false;
  if (!registered) {
    registered = true;
    dispatch_async(dispatch_get_main_queue(), ^{
      MPRemoteCommandCenter* c = [MPRemoteCommandCenter sharedCommandCenter];
      [c.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("play", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      [c.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("pause", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      [c.togglePlayPauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("toggle", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      [c.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("next", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      [c.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("prev", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      MPSkipIntervalCommand* fwd = c.skipForwardCommand; fwd.preferredIntervals = @[ @10 ];
      [fwd addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("forward", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      MPSkipIntervalCommand* back = c.skipBackwardCommand; back.preferredIntervals = @[ @10 ];
      [back addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) { emitCmd("backward", -1); return MPRemoteCommandHandlerStatusSuccess; }];
      c.changePlaybackPositionCommand.enabled = YES;
      [c.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* e) {
        MPChangePlaybackPositionCommandEvent* pe = (MPChangePlaybackPositionCommandEvent*)e;
        emitCmd("seek", pe.positionTime); return MPRemoteCommandHandlerStatusSuccess;
      }];
    });
  }
  return env.Undefined();
}

Napi::Value SetInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) { Napi::TypeError::New(env, "setInfo expects an object").ThrowAsJavaScriptException(); return env.Undefined(); }
  Napi::Object o = info[0].As<Napi::Object>();
  // Check each field's type too — As<T>() does NOT coerce, so a non-string title / non-number field
  // would throw a C++ Napi exception that main.js silently swallows (Now Playing stops updating).
  std::string title = (o.Has("title") && o.Get("title").IsString()) ? o.Get("title").As<Napi::String>().Utf8Value() : "";
  double dur = (o.Has("duration") && o.Get("duration").IsNumber()) ? o.Get("duration").As<Napi::Number>().DoubleValue() : 0;
  double elapsed = (o.Has("elapsed") && o.Get("elapsed").IsNumber()) ? o.Get("elapsed").As<Napi::Number>().DoubleValue() : 0;
  double rate = (o.Has("rate") && o.Get("rate").IsNumber()) ? o.Get("rate").As<Napi::Number>().DoubleValue() : 0;
  NSString* t = [NSString stringWithUTF8String:title.c_str()];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMutableDictionary* d = [NSMutableDictionary dictionary];
    d[MPMediaItemPropertyTitle] = t ?: @"";
    d[MPMediaItemPropertyArtist] = @"Spritz";
    if (dur > 0) d[MPMediaItemPropertyPlaybackDuration] = @(dur);
    d[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(elapsed);
    d[MPNowPlayingInfoPropertyPlaybackRate] = @(rate);
    MPNowPlayingInfoCenter* npc = [MPNowPlayingInfoCenter defaultCenter];
    npc.nowPlayingInfo = d;
    npc.playbackState = rate > 0 ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
  });
  return env.Undefined();
}

Napi::Value Clear(const Napi::CallbackInfo& info) {
  dispatch_async(dispatch_get_main_queue(), ^{
    MPNowPlayingInfoCenter* npc = [MPNowPlayingInfoCenter defaultCenter];
    npc.nowPlayingInfo = nil;
    npc.playbackState = MPNowPlayingPlaybackStateStopped;
  });
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setEventListener", Napi::Function::New(env, SetEventListener));
  exports.Set("setInfo", Napi::Function::New(env, SetInfo));
  exports.Set("clear", Napi::Function::New(env, Clear));
  return exports;
}
NODE_API_MODULE(nowplaying, Init)
