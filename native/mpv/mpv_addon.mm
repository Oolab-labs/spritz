// Spritz — libmpv Node-API addon (Objective-C++).
//
//   M1a       apiVersion()/probe()         headless libmpv smoke test.
//   M1b GATEA attachTestSurface()/detach() compositing proof (magenta, no mpv) — PASSED.
//   M1b GATEB startPlayer()/loadFile()/... real libmpv render API onto the same
//             NSOpenGLView (under the DOM): vo=libmpv, mpv_render_context (opengl),
//             update callback -> setNeedsDisplay, render with the QUERIED FBO + FLIP_Y.
//
// Bring-up simplification (deliberate, per blueprint): rendering is driven on the
// MAIN thread via the view's drawRect (the render context is created + used on the
// same thread with the GL context current), and ADVANCED_CONTROL is OFF. A dedicated
// render thread + ThreadSafeFunction property events come after the gate proves out.

#include <napi.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#import <CoreVideo/CoreVideo.h>

#include <chrono>
#include <string>
#include <thread>
#include <atomic>
#include <memory>
#include <vector>
#include <cstdio>

// ----------------------------------------------------------------------------
// M1a: headless libmpv smoke test.
// ----------------------------------------------------------------------------
static std::string ApiVersionString() {
  unsigned long v = mpv_client_api_version();
  return std::to_string((v >> 16) & 0xffff) + "." + std::to_string(v & 0xffff);
}
Napi::Value ApiVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), ApiVersionString());
}
Napi::Value Probe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string src = (info.Length() > 0 && info[0].IsString())
      ? info[0].As<Napi::String>().Utf8Value()
      : "av://lavfi:testsrc=duration=3:size=320x240:rate=30";
  mpv_handle* mpv = mpv_create();
  if (!mpv) { Napi::Error::New(env, "mpv_create failed").ThrowAsJavaScriptException(); return env.Null(); }
  mpv_set_option_string(mpv, "vo", "null");
  mpv_set_option_string(mpv, "ao", "null");
  mpv_set_option_string(mpv, "terminal", "no");
  mpv_set_option_string(mpv, "idle", "yes");
  if (mpv_initialize(mpv) < 0) { mpv_terminate_destroy(mpv); Napi::Error::New(env, "mpv_initialize failed").ThrowAsJavaScriptException(); return env.Null(); }
  char* ver = mpv_get_property_string(mpv, "mpv-version");
  std::string mpvVersion = ver ? ver : ""; if (ver) mpv_free(ver);
  mpv_observe_property(mpv, 0, "width", MPV_FORMAT_INT64);
  mpv_observe_property(mpv, 0, "height", MPV_FORMAT_INT64);
  mpv_observe_property(mpv, 0, "duration", MPV_FORMAT_DOUBLE);
  const char* cmd[] = { "loadfile", src.c_str(), nullptr };
  int loadrc = mpv_command(mpv, cmd);
  int64_t width = 0, height = 0; double duration = 0; bool loaded = false;
  auto start = std::chrono::steady_clock::now();
  while (true) {
    mpv_event* ev = mpv_wait_event(mpv, 0.1);
    if (ev->event_id == MPV_EVENT_FILE_LOADED) loaded = true;
    if (ev->event_id == MPV_EVENT_PROPERTY_CHANGE) {
      auto* p = static_cast<mpv_event_property*>(ev->data);
      std::string name = p->name ? p->name : "";
      if (p->format == MPV_FORMAT_INT64 && name == "width")  width  = *static_cast<int64_t*>(p->data);
      if (p->format == MPV_FORMAT_INT64 && name == "height") height = *static_cast<int64_t*>(p->data);
      if (p->format == MPV_FORMAT_DOUBLE && name == "duration") duration = *static_cast<double*>(p->data);
    }
    if (ev->event_id == MPV_EVENT_END_FILE) break;
    if (width && height && duration > 0) break;
    if (std::chrono::steady_clock::now() - start > std::chrono::seconds(4)) break;
  }
  mpv_terminate_destroy(mpv);
  Napi::Object out = Napi::Object::New(env);
  out.Set("apiVersion", Napi::String::New(env, ApiVersionString()));
  out.Set("mpvVersion", Napi::String::New(env, mpvVersion));
  out.Set("source", Napi::String::New(env, src));
  out.Set("loadCommandRc", Napi::Number::New(env, loadrc));
  out.Set("fileLoaded", Napi::Boolean::New(env, loaded));
  out.Set("width", Napi::Number::New(env, static_cast<double>(width)));
  out.Set("height", Napi::Number::New(env, static_cast<double>(height)));
  out.Set("duration", Napi::Number::New(env, duration));
  return out;
}

// ----------------------------------------------------------------------------
// M1b: native surface + libmpv render API.
// ----------------------------------------------------------------------------
static mpv_handle*         gMpv = nullptr;
static mpv_render_context* gRender = nullptr;
static bool                gWantPlayer = false;
static unsigned char       gLastPixel[4] = {0,0,0,0};
static int                 gFrameCount = 0;
static GLint               gLastFboBinding = -1;
static int                 gLastRenderRc = 99;   // 99 = render not yet attempted
static std::atomic<int>    gUpdateCbCount{0};    // diag: written on the (arbitrary) update-cb thread, read on main

// Property-event pump → JS (ThreadSafeFunction). The pump thread is the SOLE
// caller of mpv_wait_event; it never touches GL and never blocks the mpv core.
static Napi::ThreadSafeFunction gTsfn;
static std::thread              gPumpThread;
static std::atomic<bool>        gPumpStop{false};
static std::atomic<bool>        gHasTsfn{false};

// Value snapshot copied out of mpv_event_property BEFORE the next wait_event
// (mpv frees the data after that), then marshaled to JS on the main thread.
struct JsEv {
  std::string type;     // 'property-change' | 'file-loaded' | 'end-file'
  std::string name;
  int    valKind = 0;   // 0 null, 1 number, 2 bool, 3 string
  double num = 0;
  bool   flag = false;
  std::string str;
  int    endReason = 0;
};

static void on_mpv_render_update(void* ctx);     // fwd

// macOS GL symbol resolver for the render API (NSOpenGLContext has none).
static void* gl_get_proc_address(void* ctx, const char* name) {
  CFStringRef s = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingASCII);
  void* p = CFBundleGetFunctionPointerForName(
      CFBundleGetBundleWithIdentifier(CFSTR("com.apple.opengl")), s);
  CFRelease(s);
  return p;
}

// Create the mpv render context. MUST be called with the view's GL context
// current. Creating it BEFORE loadfile is essential — otherwise mpv's video
// output init finds "No render context set" and disables video for that file.
static int CreateRenderContextCurrent() {
  if (gRender || !gMpv) return 0;
  mpv_opengl_init_params gl_init = { gl_get_proc_address, nullptr };
  // ADVANCED_CONTROL stays OFF: enabling it (with our CVDisplayLink-driven main-thread
  // render + report_swap) deadlocked the render path / hung the main thread. EDR passthrough
  // does NOT require it — the half-float surface + target-colorspace-hint do the work.
  int advanced = 0;
  mpv_render_param cp[] = {
    { MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_OPENGL },
    { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init },
    { MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced },
    { (mpv_render_param_type)0, nullptr }
  };
  int rc = mpv_render_context_create(&gRender, gMpv, cp);
  if (rc < 0) { NSLog(@"[mpv] render_context_create failed: %d", rc); gRender = nullptr; }
  else { mpv_render_context_set_update_callback(gRender, on_mpv_render_update, nullptr); }
  return rc;
}

@interface SpritzGLView : NSOpenGLView
@end

@implementation SpritzGLView

+ (NSOpenGLPixelFormat*)pf {
  // Prefer a half-float (rgba16f) backing — required for HDR/EDR passthrough so mpv can
  // emit extended-range values rather than clamp to SDR. Fall back to 8-bit if the GPU
  // can't provide a float visual (no regression: SDR renders the same).
  NSOpenGLPixelFormatAttribute hdr[] = {
    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
    NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
    NSOpenGLPFAColorFloat, NSOpenGLPFAColorSize, 64, 0
  };
  NSOpenGLPixelFormat* p = [[[NSOpenGLPixelFormat alloc] initWithAttributes:hdr] autorelease];
  if (p) return p;
  NSOpenGLPixelFormatAttribute sdr[] = {
    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
    NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
    NSOpenGLPFAColorSize, 24, NSOpenGLPFAAlphaSize, 8, 0
  };
  return [[[NSOpenGLPixelFormat alloc] initWithAttributes:sdr] autorelease];
}

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame pixelFormat:[SpritzGLView pf]];
  if (self) {
    self.wantsBestResolutionOpenGLSurface = YES;
    self.wantsLayer = YES;
    // Opt the GL surface into Extended Dynamic Range so HDR content can exceed SDR white
    // on an EDR-capable display (harmless/no-op on SDR displays).
    if ([self respondsToSelector:@selector(setWantsExtendedDynamicRangeOpenGLSurface:)])
      [self setWantsExtendedDynamicRangeOpenGLSurface:YES];
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  }
  return self;
}

- (void)drawRect:(NSRect)dirtyRect {
  NSOpenGLContext* ctx = [self openGLContext];
  [ctx makeCurrentContext];

  // Safety net: normally the render context is created in startPlayer (before
  // loadfile); this covers any path where drawRect runs first.
  if (gWantPlayer && !gRender && gMpv) CreateRenderContextCurrent();

  GLint fbo = 0;
  glGetIntegerv(GL_FRAMEBUFFER_BINDING, &fbo);
  gLastFboBinding = fbo;
  NSRect bpx = [self convertRectToBacking:self.bounds];
  int pxW = (int)bpx.size.width, pxH = (int)bpx.size.height;

  if (gRender) {
    mpv_opengl_fbo mfbo = { (int)fbo, pxW, pxH, 0 };
    int flip = 1;
    mpv_render_param rp[] = {
      { MPV_RENDER_PARAM_OPENGL_FBO, &mfbo },
      { MPV_RENDER_PARAM_FLIP_Y, &flip },
      { (mpv_render_param_type)0, nullptr }
    };
    gLastRenderRc = mpv_render_context_render(gRender, rp);
    glReadPixels(pxW/2, pxH/2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, gLastPixel);
    [ctx flushBuffer];
    mpv_render_context_report_swap(gRender);
  } else {
    // Idle fill (no player / before first frame): app background (#0b0b0f),
    // so nothing flashes when the welcome screen hides before video starts.
    glViewport(0, 0, pxW, pxH);
    glClearColor(0.043f, 0.043f, 0.059f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glReadPixels(pxW/2, pxH/2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, gLastPixel);
    [ctx flushBuffer];
  }
  gFrameCount++;
}
@end

static SpritzGLView* gVideoView = nil;
static NSView*     gContentView = nil;
static CVDisplayLinkRef gDisplayLink = NULL;

static void on_mpv_render_update(void* ctx) {
  // Arbitrary thread: signal only — never call mpv/GL here.
  gUpdateCbCount.fetch_add(1, std::memory_order_relaxed);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (gVideoView) [gVideoView setNeedsDisplay:YES];
  });
}

// CVDisplayLink — a vsync-aligned clock at the display's TRUE refresh (60/120Hz ProMotion),
// replacing the fixed 60Hz NSTimer. Basic playback is already driven by on_mpv_render_update
// (fires per decoded frame); this steady display-rate clock is what lets mpv's interpolation
// render in-between frames at the right cadence, and is the foundation for HDR EDR work.
static CVReturn displayLinkCb(CVDisplayLinkRef dl, const CVTimeStamp* now, const CVTimeStamp* out,
                              CVOptionFlags flags, CVOptionFlags* flagsOut, void* ctx) {
  dispatch_async(dispatch_get_main_queue(), ^{ if (gVideoView) [gVideoView setNeedsDisplay:YES]; });
  return kCVReturnSuccess; // setNeedsDisplay coalesces, so we never flood the main queue
}
static NSTimer* gFallbackTimer = nil; // used only if the display link can't start
static void stopDisplayLink() {
  if (gDisplayLink) { CVDisplayLinkStop(gDisplayLink); CVDisplayLinkRelease(gDisplayLink); gDisplayLink = NULL; }
  if (gFallbackTimer) { [gFallbackTimer invalidate]; gFallbackTimer = nil; }
}
static void startDisplayLink() {
  stopDisplayLink();
  bool ok = false;
  if (CVDisplayLinkCreateWithActiveCGDisplays(&gDisplayLink) == kCVReturnSuccess && gDisplayLink) {
    CVDisplayLinkSetOutputCallback(gDisplayLink, displayLinkCb, NULL);
    ok = (CVDisplayLinkStart(gDisplayLink) == kCVReturnSuccess);
    if (!ok) { CVDisplayLinkRelease(gDisplayLink); gDisplayLink = NULL; }
  }
  if (!ok) { // guarantee a redraw clock — fall back to the original steady 60Hz timer
    gFallbackTimer = [NSTimer scheduledTimerWithTimeInterval:(1.0 / 60.0) repeats:YES block:^(NSTimer* t) {
      if (gVideoView) [gVideoView setNeedsDisplay:YES];
    }];
  }
}

static void RunOnMain(void (^block)(void)) {
  if ([NSThread isMainThread]) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

// attachTestSurface(handle: Buffer) — create + insert the GL view below the web layer.
Napi::Value AttachTestSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "expected getNativeWindowHandle() Buffer").ThrowAsJavaScriptException();
    return env.Null();
  }
  NSView* content = *reinterpret_cast<NSView**>(info[0].As<Napi::Buffer<char>>().Data());
  if (!content) { Napi::Error::New(env, "null NSView from handle").ThrowAsJavaScriptException(); return env.Null(); }
  RunOnMain(^{
    // Idempotent re-attach: fully tear down the prior surface so we never leak a
    // timer/content-view retain or leave a render context bound to a freed GL view.
    stopDisplayLink();
    if (gVideoView) {
      if (gRender) { // render ctx is bound to the OLD view's GL context — free it first
        mpv_render_context_set_update_callback(gRender, nullptr, nullptr);
        [[gVideoView openGLContext] makeCurrentContext];
        mpv_render_context_free(gRender); gRender = nullptr;
      }
      [gVideoView removeFromSuperview]; [gVideoView release]; gVideoView = nil;
    }
    if (gContentView) { [gContentView release]; gContentView = nil; }
    gContentView = [content retain];
    gVideoView = [[SpritzGLView alloc] initWithFrame:[content bounds]];
    [content addSubview:gVideoView positioned:NSWindowBelow relativeTo:nil];
    [gVideoView setNeedsDisplay:YES];
    startDisplayLink(); // vsync-aligned redraw clock at the real display refresh
  });
  Napi::Object out = Napi::Object::New(env);
  out.Set("attached", Napi::Boolean::New(env, true));
  return out;
}

// Serialize an mpv_node (e.g. the track-list array) to a JSON string on the pump
// thread (N-API objects can't be built off the JS thread). The renderer JSON.parses
// it. Done in-pump so the node data is read before the next mpv_wait_event frees it.
static void jsonEscape(const char* s, std::string& out) {
  if (!s) return;
  for (; *s; ++s) {
    unsigned char c = (unsigned char)*s;
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
        else out += (char)c;
    }
  }
}
static void nodeToJson(const mpv_node* n, std::string& out, int depth = 0) {
  if (depth > 32) { out += "null"; return; } // bound recursion on untrusted-depth nodes (stack safety)
  switch (n->format) {
    case MPV_FORMAT_STRING: out += '"'; jsonEscape(n->u.string, out); out += '"'; break;
    case MPV_FORMAT_FLAG:   out += (n->u.flag ? "true" : "false"); break;
    case MPV_FORMAT_INT64:  out += std::to_string(n->u.int64); break;
    case MPV_FORMAT_DOUBLE: {
      // %.17g (full round-trip precision, not std::to_string's 6 digits), then force a '.' decimal
      // separator so a non-C process locale can't emit ',' and break the renderer's JSON.parse.
      char buf[32]; snprintf(buf, sizeof(buf), "%.17g", n->u.double_);
      for (char* p = buf; *p; ++p) if (*p == ',') *p = '.';
      out += buf; break;
    }
    case MPV_FORMAT_NODE_ARRAY:
      out += '[';
      for (int i = 0; i < n->u.list->num; i++) { if (i) out += ','; nodeToJson(&n->u.list->values[i], out, depth + 1); }
      out += ']'; break;
    case MPV_FORMAT_NODE_MAP:
      out += '{';
      for (int i = 0; i < n->u.list->num; i++) {
        if (i) out += ',';
        out += '"'; jsonEscape(n->u.list->keys[i], out); out += "\":";
        nodeToJson(&n->u.list->values[i], out, depth + 1);
      }
      out += '}'; break;
    default: out += "null"; break; // MPV_FORMAT_NONE / unknown
  }
}

// Runs on the JS main thread: build the event object and call the listener.
static void EmitToJs(Napi::Env env, Napi::Function fn, JsEv* e) {
  std::unique_ptr<JsEv> ev(e); // frees on EVERY path: normal, env==null (finalize/abort), or throw
  if (env != nullptr && fn != nullptr) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("type", e->type);
    if (!e->name.empty()) o.Set("name", e->name);
    switch (e->valKind) {
      case 1: o.Set("value", Napi::Number::New(env, e->num)); break;
      case 2: o.Set("value", Napi::Boolean::New(env, e->flag)); break;
      case 3: o.Set("value", Napi::String::New(env, e->str)); break;
      default: o.Set("value", env.Null()); break;
    }
    if (e->type == "end-file") o.Set("reason", Napi::Number::New(env, e->endReason));
    // A throwing JS listener must not escape the TSFN callback (would leave a
    // pending exception on the env). Swallow + log.
    try { fn.Call({ o }); }
    catch (const Napi::Error& err) { NSLog(@"[mpv] event listener threw: %s", err.what()); }
  }
}

// Dedicated mpv event-pump thread. Blocks on mpv_wait_event(-1); woken for
// teardown by mpv_wakeup() + gPumpStop.
static void EventPumpLoop() {
  while (!gPumpStop.load()) {
    mpv_event* ev = mpv_wait_event(gMpv, -1.0);
    if (!ev) continue;
    if (ev->event_id == MPV_EVENT_NONE) { if (gPumpStop.load()) break; else continue; }
    if (ev->event_id == MPV_EVENT_SHUTDOWN) break;
    if (!gHasTsfn) continue;

    JsEv* e = nullptr;
    if (ev->event_id == MPV_EVENT_PROPERTY_CHANGE) {
      auto* p = static_cast<mpv_event_property*>(ev->data);
      e = new JsEv();
      e->type = "property-change";
      e->name = p->name ? p->name : "";
      switch (p->format) {
        case MPV_FORMAT_DOUBLE: e->valKind = 1; e->num = *static_cast<double*>(p->data); break;
        case MPV_FORMAT_INT64:  e->valKind = 1; e->num = (double)*static_cast<int64_t*>(p->data); break;
        case MPV_FORMAT_FLAG:   e->valKind = 2; e->flag = (*static_cast<int*>(p->data)) != 0; break;
        case MPV_FORMAT_STRING:
        case MPV_FORMAT_OSD_STRING: {
          char** s = static_cast<char**>(p->data);
          e->valKind = 3; e->str = (s && *s) ? *s : "";
          break;
        }
        case MPV_FORMAT_NODE: { // e.g. track-list → JSON string; renderer parses
          mpv_node* node = static_cast<mpv_node*>(p->data);
          e->valKind = 3;
          if (node) nodeToJson(node, e->str);
          break;
        }
        default: e->valKind = 0; break; // MPV_FORMAT_NONE → unavailable
      }
    } else if (ev->event_id == MPV_EVENT_FILE_LOADED) {
      e = new JsEv(); e->type = "file-loaded";
    } else if (ev->event_id == MPV_EVENT_END_FILE) {
      auto* ef = static_cast<mpv_event_end_file*>(ev->data);
      e = new JsEv(); e->type = "end-file"; e->endReason = ef ? (int)ef->reason : 0;
    }
    if (e) {
      napi_status st = gTsfn.NonBlockingCall(e, EmitToJs);
      if (st != napi_ok) delete e; // queue closing/full — drop (next event supersedes)
    }
  }
}

// setEventListener(fn) — register the JS callback for mpv events. Call BEFORE
// startPlayer so initial observed-property values are delivered.
Napi::Value SetEventListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "expected a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Re-registration while the pump thread is live would race the pump's reads of
  // gTsfn/gHasTsfn (Release()+reassign vs NonBlockingCall). Enforce the documented
  // "before startPlayer" invariant in code. (gMpv/pump are torn down by detach,
  // so re-registering after a detach is fine.)
  if (gMpv != nullptr || gPumpThread.joinable()) {
    Napi::Error::New(env, "setEventListener must be called before startPlayer").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (gHasTsfn) { gTsfn.Release(); gHasTsfn = false; } // safe: only the pre-startPlayer double-call path
  gTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "mpvEvents", 0, 1);
  gHasTsfn = true;
  return env.Undefined();
}

// startPlayer() — create + initialize the mpv core for render-API output.
Napi::Value StartPlayer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (gMpv) { Napi::Object o = Napi::Object::New(env); o.Set("started", Napi::Boolean::New(env, true)); return o; }
  gMpv = mpv_create();
  if (!gMpv) { Napi::Error::New(env, "mpv_create failed").ThrowAsJavaScriptException(); return env.Null(); }
  mpv_set_option_string(gMpv, "terminal", "no");
  mpv_set_option_string(gMpv, "msg-level", "all=error");
  mpv_set_option_string(gMpv, "vo", "libmpv");
  mpv_set_option_string(gMpv, "hwdec", "auto-copy");   // VideoToolbox on Apple Silicon
  // High-quality GPU rendering — this libmpv links libplacebo, so the high-quality
  // profile (ewa_lanczossharp up/cscale, mitchell downscale, sigmoid, debanding,
  // auto dithering) is available through the render API.
  mpv_set_option_string(gMpv, "profile", "high-quality");
  // HDR handling. The half-float EDR GL surface + `target-colorspace-hint` let mpv pass
  // HDR10/HLG THROUGH to an EDR-capable display (extended-range output); on an SDR display
  // it tone-maps with the bt.2390 perceptual curve + perceptual gamut mapping so it isn't
  // washed-out. `hdr-compute-peak` is omitted (needs ADVANCED_CONTROL — off — to be stable).
  mpv_set_option_string(gMpv, "target-colorspace-hint", "yes");
  mpv_set_option_string(gMpv, "tone-mapping", "bt.2390");
  mpv_set_option_string(gMpv, "gamut-mapping-mode", "perceptual");
  int rc = mpv_initialize(gMpv);
  if (rc < 0) { mpv_terminate_destroy(gMpv); gMpv = nullptr; Napi::Error::New(env, "mpv_initialize failed").ThrowAsJavaScriptException(); return env.Null(); }

  // Observe the properties the ported player UI needs (M2 maps these 1:1 to the
  // old handlePropertyChange events).
  mpv_observe_property(gMpv, 0, "duration",        MPV_FORMAT_DOUBLE);
  mpv_observe_property(gMpv, 0, "time-pos",        MPV_FORMAT_DOUBLE);
  mpv_observe_property(gMpv, 0, "pause",           MPV_FORMAT_FLAG);
  mpv_observe_property(gMpv, 0, "eof-reached",     MPV_FORMAT_FLAG);
  mpv_observe_property(gMpv, 0, "seekable",        MPV_FORMAT_FLAG);
  mpv_observe_property(gMpv, 0, "seeking",         MPV_FORMAT_FLAG);
  mpv_observe_property(gMpv, 0, "paused-for-cache",MPV_FORMAT_FLAG);
  mpv_observe_property(gMpv, 0, "dwidth",          MPV_FORMAT_INT64);
  mpv_observe_property(gMpv, 0, "dheight",         MPV_FORMAT_INT64);
  mpv_observe_property(gMpv, 0, "hwdec-current",   MPV_FORMAT_STRING);
  mpv_observe_property(gMpv, 0, "track-list",      MPV_FORMAT_NODE);   // audio/sub menu structure
  mpv_observe_property(gMpv, 0, "aid",             MPV_FORMAT_STRING); // selection (track-list doesn't
  mpv_observe_property(gMpv, 0, "sid",             MPV_FORMAT_STRING); //  re-fire on selection change)

  // Start the event pump (delivers the above to JS via the TSFN).
  gPumpStop = false;
  gPumpThread = std::thread(EventPumpLoop);

  gWantPlayer = true;
  __block int crc = -999;
  RunOnMain(^{
    if (gVideoView) {
      [[gVideoView openGLContext] makeCurrentContext];
      crc = CreateRenderContextCurrent();   // BEFORE loadfile — avoids "No render context set"
      [gVideoView setNeedsDisplay:YES];
    }
  });
  Napi::Object out = Napi::Object::New(env);
  out.Set("started", Napi::Boolean::New(env, true));
  out.Set("initRc", Napi::Number::New(env, rc));
  out.Set("renderCtxRc", Napi::Number::New(env, crc));
  return out;
}

// loadFile(url)
Napi::Value LoadFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gMpv) { Napi::Error::New(env, "player not started").ThrowAsJavaScriptException(); return env.Null(); }
  if (info.Length() < 1 || !info[0].IsString()) { Napi::TypeError::New(env, "loadFile expects a url string").ThrowAsJavaScriptException(); return env.Null(); }
  std::string url = info[0].As<Napi::String>().Utf8Value();
  const char* cmd[] = { "loadfile", url.c_str(), "replace", nullptr };
  int rc = mpv_command(gMpv, cmd);
  RunOnMain(^{ if (gVideoView) [gVideoView setNeedsDisplay:YES]; });
  Napi::Object out = Napi::Object::New(env);
  out.Set("loadRc", Napi::Number::New(env, rc));
  return out;
}

// command(name, ...args) — generic mpv_command passthrough (stop, seek, frame-step,
// sub-add, etc.). Args stringified, matching the old driver's command() semantics.
Napi::Value Command(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gMpv) return env.Undefined();
  std::vector<std::string> args;
  for (size_t i = 0; i < info.Length(); i++) {
    Napi::Value v = info[i];
    if (v.IsString())       args.push_back(v.As<Napi::String>().Utf8Value());
    else if (v.IsNumber())  args.push_back(std::to_string(v.As<Napi::Number>().DoubleValue()));
    else if (v.IsBoolean()) args.push_back(v.As<Napi::Boolean>().Value() ? "yes" : "no");
  }
  std::vector<const char*> argv;
  argv.reserve(args.size() + 1);
  for (auto& s : args) argv.push_back(s.c_str());
  argv.push_back(nullptr);
  int rc = mpv_command(gMpv, argv.data());
  return Napi::Number::New(env, rc);
}

// playerStat() — read-back proof of playback (safe: client API, off the render path).
Napi::Value PlayerStat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  if (gMpv) {
    double tp = 0, dur = 0; int64_t w = 0, h = 0; int paused = 0;
    mpv_get_property(gMpv, "time-pos", MPV_FORMAT_DOUBLE, &tp);
    mpv_get_property(gMpv, "duration", MPV_FORMAT_DOUBLE, &dur);
    mpv_get_property(gMpv, "dwidth",  MPV_FORMAT_INT64,  &w);
    mpv_get_property(gMpv, "dheight", MPV_FORMAT_INT64,  &h);
    mpv_get_property(gMpv, "pause",   MPV_FORMAT_FLAG,   &paused);
    char* hw = mpv_get_property_string(gMpv, "hwdec-current");
    char* aid = mpv_get_property_string(gMpv, "aid");
    char* sid = mpv_get_property_string(gMpv, "sid");
    out.Set("aid", Napi::String::New(env, aid ? aid : ""));
    out.Set("sid", Napi::String::New(env, sid ? sid : ""));
    if (aid) mpv_free(aid);
    if (sid) mpv_free(sid);
    out.Set("timePos", Napi::Number::New(env, tp));
    out.Set("duration", Napi::Number::New(env, dur));
    out.Set("width", Napi::Number::New(env, (double)w));
    out.Set("height", Napi::Number::New(env, (double)h));
    out.Set("paused", Napi::Boolean::New(env, paused != 0));
    out.Set("hwdec", Napi::String::New(env, hw ? hw : ""));
    if (hw) mpv_free(hw);
  }
  out.Set("renderActive", Napi::Boolean::New(env, gRender != nullptr));
  out.Set("frameCount", Napi::Number::New(env, gFrameCount));
  out.Set("updateCbCount", Napi::Number::New(env, gUpdateCbCount.load(std::memory_order_relaxed)));
  out.Set("lastRenderRc", Napi::Number::New(env, gLastRenderRc));
  out.Set("fboBinding", Napi::Number::New(env, gLastFboBinding));
  Napi::Array px = Napi::Array::New(env, 4);
  for (int i = 0; i < 4; i++) px.Set(i, Napi::Number::New(env, gLastPixel[i]));
  out.Set("centerPixel", px);
  return out;
}

// mediaStats() — diagnostics for the stats overlay (codecs, bitrate, fps, dropped frames).
Napi::Value MediaStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  if (!gMpv) return o;
  auto str = [&](const char* prop, const char* key) {
    char* v = mpv_get_property_string(gMpv, prop);
    o.Set(key, Napi::String::New(env, v ? v : "")); if (v) mpv_free(v);
  };
  auto num = [&](const char* prop, const char* key) {
    double d = 0; mpv_get_property(gMpv, prop, MPV_FORMAT_DOUBLE, &d);
    o.Set(key, Napi::Number::New(env, d));
  };
  auto i64 = [&](const char* prop, const char* key) {
    int64_t n = 0; mpv_get_property(gMpv, prop, MPV_FORMAT_INT64, &n);
    o.Set(key, Napi::Number::New(env, (double)n));
  };
  str("video-codec", "vcodec"); str("audio-codec", "acodec");
  str("hwdec-current", "hwdec"); str("video-format", "vformat");
  i64("video-bitrate", "vbitrate"); i64("audio-bitrate", "abitrate");
  num("estimated-vf-fps", "fps"); num("container-fps", "containerFps");
  i64("frame-drop-count", "drops"); i64("decoder-frame-drop-count", "decoderDrops");
  i64("dwidth", "width"); i64("dheight", "height");
  num("demuxer-cache-duration", "cacheSecs");
  return o;
}

// setProperty(name, value) — minimal control surface for the gate (pause etc.).
Napi::Value SetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gMpv) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString()) { Napi::TypeError::New(env, "setProperty expects (name, value)").ThrowAsJavaScriptException(); return env.Undefined(); }
  std::string name = info[0].As<Napi::String>().Utf8Value();
  if (info[1].IsBoolean()) { int f = info[1].As<Napi::Boolean>().Value() ? 1 : 0; mpv_set_property(gMpv, name.c_str(), MPV_FORMAT_FLAG, &f); }
  else if (info[1].IsNumber()) { double d = info[1].As<Napi::Number>().DoubleValue(); mpv_set_property(gMpv, name.c_str(), MPV_FORMAT_DOUBLE, &d); }
  else { std::string s = info[1].As<Napi::String>().Utf8Value(); mpv_set_property_string(gMpv, name.c_str(), s.c_str()); }
  return env.Undefined();
}

Napi::Value GlSelfCheck(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  Napi::Array px = Napi::Array::New(env, 4);
  for (int i = 0; i < 4; i++) px.Set(i, Napi::Number::New(env, gLastPixel[i]));
  out.Set("frameCount", Napi::Number::New(env, gFrameCount));
  out.Set("centerPixel", px);
  out.Set("fboBinding", Napi::Number::New(env, gLastFboBinding));
  out.Set("presents", Napi::Boolean::New(env, gFrameCount > 0));
  return out;
}

static void DetachCore() {
  RunOnMain(^{
    stopDisplayLink();

    // Stop the event pump BEFORE destroying mpv. mpv_wait_event(-1) is unblocked
    // by mpv_wakeup(); the flag makes the loop exit.
    if (gPumpThread.joinable()) {
      gPumpStop = true;
      if (gMpv) mpv_wakeup(gMpv);
      gPumpThread.join();
    }
    if (gHasTsfn) { gTsfn.Release(); gHasTsfn = false; } // unref Node loop so it can finalize

    // Free the render context on the GL thread (ctx current) BEFORE core destroy.
    if (gRender) {
      mpv_render_context_set_update_callback(gRender, nullptr, nullptr);
      if (gVideoView) [[gVideoView openGLContext] makeCurrentContext];
      mpv_render_context_free(gRender); gRender = nullptr;
    }
    if (gMpv) { mpv_terminate_destroy(gMpv); gMpv = nullptr; }
    gWantPlayer = false;
    if (gVideoView) { [gVideoView removeFromSuperview]; [gVideoView release]; gVideoView = nil; }
    if (gContentView) { [gContentView release]; gContentView = nil; }
  });
}

Napi::Value Detach(const Napi::CallbackInfo& info) {
  DetachCore();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("apiVersion", Napi::Function::New(env, ApiVersion));
  exports.Set("probe", Napi::Function::New(env, Probe));
  exports.Set("attachTestSurface", Napi::Function::New(env, AttachTestSurface));
  exports.Set("glSelfCheck", Napi::Function::New(env, GlSelfCheck));
  exports.Set("setEventListener", Napi::Function::New(env, SetEventListener));
  exports.Set("startPlayer", Napi::Function::New(env, StartPlayer));
  exports.Set("loadFile", Napi::Function::New(env, LoadFile));
  exports.Set("command", Napi::Function::New(env, Command));
  exports.Set("playerStat", Napi::Function::New(env, PlayerStat));
  exports.Set("mediaStats", Napi::Function::New(env, MediaStats));
  exports.Set("setProperty", Napi::Function::New(env, SetProperty));
  exports.Set("detach", Napi::Function::New(env, Detach));
  // Safety net: run teardown at env shutdown so the pump thread / TSFN / mpv are
  // cleaned up even if the window 'closed' handler is bypassed (e.g. Cmd+Q).
  napi_add_env_cleanup_hook(env, [](void*){ DetachCore(); }, nullptr);
  return exports;
}

NODE_API_MODULE(mpv_render, Init)
