// AppKit's sidebar glass behind a DynWork window, the way Claude desktop shows it on macOS 26 and later. An
// `NSSplitViewController` whose sidebar spans the whole window draws the glass, and a solid colour sits behind it, so
// the glass takes the desktop picture's tint and never the windows behind. The page draws over both: the shell's chrome
// is transparent and shows the glass, its panels are opaque. `@dynwork/build`'s vite plugin compiles this file for both
// Mac architectures, and `glass.ts` loads it in the main process.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Node-API is ABI-stable, so the few functions this addon calls are declared here instead of taken from node_api.h,
// which no Mac runner has installed.
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern "C" {
int napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
int napi_get_buffer_info(napi_env, napi_value, void**, size_t*);
int napi_get_value_string_utf8(napi_env, napi_value, char*, size_t, size_t*);
int napi_get_undefined(napi_env, napi_value*);
int napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
int napi_set_named_property(napi_env, napi_value, const char*, napi_value);
}

// What one window holds, kept on the window itself so it goes when the window does.
@interface DynWorkSidebarGlass : NSObject
@property(strong) NSView* container;
@property(strong) NSView* backing;
@property(strong) NSSplitViewController* split;
@end

// The view the glass and its colour live in. Chromium sorts the content view's subviews whenever it attaches a native
// view, such as the in-app browser's page, and puts the subviews it does not own above its own: the glass then covered
// the whole page, and the window showed nothing but glass. This view draws behind its siblings wherever it sits among
// them (its layer's `zPosition`), and lets every click through to the page.
@interface DynWorkGlassContainer : NSView
@end

@implementation DynWorkGlassContainer
- (NSView*)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation DynWorkSidebarGlass
@end

static char holderKey;

// `BrowserWindow.getNativeWindowHandle()` is a buffer that holds the window's content `NSView*`.
static NSWindow* windowOf(napi_env env, napi_value handle) {
  void* data;
  size_t length;
  napi_get_buffer_info(env, handle, &data, &length);
  return (*(NSView* __unsafe_unretained*)data).window;
}

// A `#rrggbb` colour.
static CGColorRef colorOf(napi_env env, napi_value value) {
  char hex[8] = {0};
  size_t length = 0;
  napi_get_value_string_utf8(env, value, hex, sizeof hex, &length);
  unsigned rgb = (unsigned)strtoul(hex + 1, NULL, 16);
  return [NSColor colorWithSRGBRed:((rgb >> 16) & 255) / 255.0
                             green:((rgb >> 8) & 255) / 255.0
                              blue:(rgb & 255) / 255.0
                             alpha:1]
      .CGColor;
}

static napi_value undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

// attach(handle, color): puts the glass behind the window's content over `color`, or only changes the colour when the
// window already has it.
static napi_value attach(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow* window = windowOf(env, argv[0]);
  CGColorRef color = colorOf(env, argv[1]);
  DynWorkSidebarGlass* holder = objc_getAssociatedObject(window, &holderKey);
  if (holder) {
    holder.backing.layer.backgroundColor = color;
    return undefined(env);
  }

  NSView* content = window.contentView;
  holder = [DynWorkSidebarGlass new];
  holder.container = [[DynWorkGlassContainer alloc] initWithFrame:content.bounds];
  holder.container.wantsLayer = YES;
  holder.container.layer.zPosition = -1;
  holder.container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  holder.backing = [[NSView alloc] initWithFrame:content.bounds];
  holder.backing.wantsLayer = YES;
  holder.backing.layer.backgroundColor = color;
  holder.backing.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  // The sidebar is the split view's only item, so it spans the whole window and the chrome around the panels shows the
  // same glass as the sidebar, in every layout. Its thickness is set once, here, with no upper bound: the split view
  // follows the window through its autoresizing mask. Changing a split item's thickness while the window resizes
  // invalidates the window's constraints from inside its layout pass, and macOS 26 raises an exception for that loop
  // (`-[NSWindow _postWindowNeedsUpdateConstraints]`) and quits the app.
  NSViewController* side = [NSViewController new];
  side.view = [[NSView alloc] initWithFrame:content.bounds];
  NSSplitViewItem* sidebar = [NSSplitViewItem sidebarWithViewController:side];
  sidebar.minimumThickness = 0;
  sidebar.maximumThickness = NSSplitViewItemUnspecifiedDimension;
  sidebar.canCollapse = NO;
  holder.split = [NSSplitViewController new];
  [holder.split addSplitViewItem:sidebar];
  holder.split.view.frame = content.bounds;
  holder.split.view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  [holder.container addSubview:holder.backing];
  [holder.container addSubview:holder.split.view];
  [content addSubview:holder.container positioned:NSWindowBelow relativeTo:nil];
  objc_setAssociatedObject(window, &holderKey, holder, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return undefined(env);
}

// detach(handle): takes the glass and its colour out of the window.
static napi_value detach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSWindow* window = windowOf(env, argv[0]);
  DynWorkSidebarGlass* holder = objc_getAssociatedObject(window, &holderKey);
  if (!holder) return undefined(env);
  [holder.container removeFromSuperview];
  objc_setAssociatedObject(window, &holderKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return undefined(env);
}

extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "attach", SIZE_MAX, attach, NULL, &function);
  napi_set_named_property(env, exports, "attach", function);
  napi_create_function(env, "detach", SIZE_MAX, detach, NULL, &function);
  napi_set_named_property(env, exports, "detach", function);
  return exports;
}
