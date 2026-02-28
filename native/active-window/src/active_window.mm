#import <napi.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

static Napi::Value GetActiveWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  @autoreleasepool {
    // Get the frontmost application
    NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (!frontApp) {
      return env.Null();
    }

    pid_t pid = frontApp.processIdentifier;
    NSString *appName = frontApp.localizedName ?: @"";
    NSString *bundleId = frontApp.bundleIdentifier ?: @"";

    // Get all on-screen windows, excluding desktop elements
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID
    );

    if (!windowList) {
      return env.Null();
    }

    NSArray *windows = CFBridgingRelease(windowList);

    // Find the best matching window for the frontmost app
    NSDictionary *bestWindow = nil;
    for (NSDictionary *win in windows) {
      NSNumber *ownerPID = win[(__bridge NSString *)kCGWindowOwnerPID];
      NSNumber *layer = win[(__bridge NSString *)kCGWindowLayer];

      if (ownerPID.intValue != pid) continue;
      if (layer.intValue != 0) continue;

      // Skip transparent windows
      NSNumber *alpha = win[(__bridge NSString *)kCGWindowAlpha];
      if (alpha && alpha.floatValue <= 0.0f) continue;

      // Skip tiny windows (< 50px in either dimension)
      NSDictionary *bounds = win[(__bridge NSString *)kCGWindowBounds];
      if (bounds) {
        CGFloat w = [bounds[@"Width"] floatValue];
        CGFloat h = [bounds[@"Height"] floatValue];
        if (w < 50 || h < 50) continue;
      }

      bestWindow = win;
      break;
    }

    if (!bestWindow) {
      return env.Null();
    }

    // Build the result object
    Napi::Object result = Napi::Object::New(env);

    // Window title (may be nil if Screen Recording TCC not granted)
    NSString *title = bestWindow[(__bridge NSString *)kCGWindowName] ?: @"";
    result.Set("title", std::string([title UTF8String]));

    result.Set("owner", std::string([appName UTF8String]));
    result.Set("bundleId", std::string([bundleId UTF8String]));

    // Window ID
    NSNumber *windowNumber = bestWindow[(__bridge NSString *)kCGWindowNumber];
    result.Set("windowId", windowNumber ? [windowNumber intValue] : -1);

    result.Set("pid", static_cast<int>(pid));

    // Bounds
    NSDictionary *boundsDict = bestWindow[(__bridge NSString *)kCGWindowBounds];
    if (boundsDict) {
      Napi::Object bounds = Napi::Object::New(env);
      double x = [boundsDict[@"X"] doubleValue];
      double y = [boundsDict[@"Y"] doubleValue];
      double w = [boundsDict[@"Width"] doubleValue];
      double h = [boundsDict[@"Height"] doubleValue];
      bounds.Set("x", x);
      bounds.Set("y", y);
      bounds.Set("width", w);
      bounds.Set("height", h);
      // Aliases for backward compat with existing code
      bounds.Set("w", w);
      bounds.Set("h", h);
      result.Set("bounds", bounds);
    }

    return result;
  }
}

// ─── Focus Window by PID ──────────────────────────────────────────────────────

static Napi::Value FocusWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Napi::Boolean::New(env, false);
  }

  pid_t pid = info[0].As<Napi::Number>().Int32Value();

  @autoreleasepool {
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app) return Napi::Boolean::New(env, false);

    BOOL success = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    return Napi::Boolean::New(env, success);
  }
}

// ─── Module Init ──────────────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getActiveWindow", Napi::Function::New(env, GetActiveWindow));
  exports.Set("focusWindow", Napi::Function::New(env, FocusWindow));
  return exports;
}

NODE_API_MODULE(active_window, Init)
