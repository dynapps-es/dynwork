// A minimal Hermes host for `bun run test:hermes`. Hermes ships no command-line VM in npm, so this links the macOS
// slice of the same `hermesvm` framework React Native 0.88 embeds and runs one bundle (source or HBC bytecode) in it.
//
// It provides only what a React Native app also has on top of the bare engine:
// - `print` (the console of this host);
// - `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate` and `clearImmediate`, as RN's timers;
// - `console`, `queueMicrotask` and `performance.now`, as RN's InitializeCore installs them;
// - `crypto.getRandomValues`, as `expo-crypto` or `react-native-get-random-values` install it.
// Everything else (Promise, the microtask queue, TextEncoder, Intl...) is the engine's own. The process exit code is
// the value the bundle leaves in `globalThis.__exitCode`: 1 when it leaves none, 70 when the bundle throws. The
// bundle calls `__finish()` when it is done: timers still pending then (a session's resume deadline) are abandoned, as
// `bun test` abandons them.

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <thread>

namespace jsi = facebook::jsi;

namespace {

struct Timer {
  jsi::Function callback;
  double interval;  // < 0 when the timer does not repeat
};

using Clock = std::chrono::steady_clock;

const char *prelude = R"js(
(function () {
  var log = function () { print.apply(null, Array.prototype.map.call(arguments, String)) }
  var noop = function () {}
  globalThis.console = { log: log, info: log, warn: log, error: log, debug: log, group: noop, groupEnd: noop,
    groupCollapsed: log }
  globalThis.queueMicrotask = function (fn) { Promise.resolve().then(fn) }
  var now = __hostNow
  globalThis.performance = { now: function () { return now() } }
  delete globalThis.__hostNow
})()
)js";

// Timers ordered by due time, then by creation order, as browsers and RN order equal deadlines.
std::map<std::pair<Clock::time_point, uint64_t>, uint64_t> queue;
std::map<uint64_t, Timer> timers;
uint64_t nextId = 1;
bool finished = false;

uint64_t schedule(jsi::Runtime &rt, const jsi::Value *args, size_t count, bool repeat, bool immediate) {
  if (count < 1 || !args[0].isObject() || !args[0].asObject(rt).isFunction(rt))
    throw jsi::JSError(rt, "timer callback must be a function");
  double delay = immediate || count < 2 || !args[1].isNumber() ? 0 : args[1].asNumber();
  if (delay < 0 || delay != delay) delay = 0;
  uint64_t id = nextId++;
  timers.emplace(id, Timer{args[0].asObject(rt).asFunction(rt), repeat ? delay : -1});
  queue.emplace(std::make_pair(Clock::now() + std::chrono::microseconds(static_cast<int64_t>(delay * 1000)), id), id);
  return id;
}

void cancel(jsi::Runtime &rt, const jsi::Value *args, size_t count) {
  if (count < 1 || !args[0].isNumber()) return;
  timers.erase(static_cast<uint64_t>(args[0].asNumber()));
}

void define(jsi::Runtime &rt, jsi::Object &target, const char *name, unsigned length, jsi::HostFunctionType fn) {
  target.setProperty(rt, name, jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), length,
                                                                      std::move(fn)));
}

void install(jsi::Runtime &rt) {
  auto global = rt.global();
  define(rt, global, "print", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
    std::ostringstream line;
    for (size_t i = 0; i < count; i++) line << (i ? " " : "") << args[i].toString(rt).utf8(rt);
    std::cout << line.str() << std::endl;
    return jsi::Value::undefined();
  });
  for (auto repeat : {false, true}) {
    define(rt, global, repeat ? "setInterval" : "setTimeout", 2,
           [repeat](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
             return jsi::Value(static_cast<double>(schedule(rt, args, count, repeat, false)));
           });
    define(rt, global, repeat ? "clearInterval" : "clearTimeout", 1,
           [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
             cancel(rt, args, count);
             return jsi::Value::undefined();
           });
  }
  define(rt, global, "setImmediate", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
    return jsi::Value(static_cast<double>(schedule(rt, args, count, false, true)));
  });
  define(rt, global, "clearImmediate", 1,
         [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
           cancel(rt, args, count);
           return jsi::Value::undefined();
         });
  auto crypto = jsi::Object(rt);
  define(rt, crypto, "getRandomValues", 1,
         [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
           if (count < 1 || !args[0].isObject()) throw jsi::JSError(rt, "getRandomValues expects a typed array");
           auto view = args[0].asObject(rt);
           auto buffer = view.getProperty(rt, "buffer").asObject(rt).getArrayBuffer(rt);
           auto offset = static_cast<size_t>(view.getProperty(rt, "byteOffset").asNumber());
           auto length = static_cast<size_t>(view.getProperty(rt, "byteLength").asNumber());
           if (length > 65536) throw jsi::JSError(rt, "getRandomValues: quota exceeded");
           arc4random_buf(buffer.data(rt) + offset, length);
           return jsi::Value(rt, args[0]);
         });
  global.setProperty(rt, "crypto", crypto);
  define(rt, global, "__finish", 0, [](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) {
    finished = true;
    return jsi::Value::undefined();
  });
  auto start = Clock::now();
  define(rt, global, "__hostNow", 0, [start](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) {
    return jsi::Value(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
  });
  rt.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(prelude), "prelude.js");
}

// Runs the microtasks, then the earliest due timer, until nothing is left.
void loop(facebook::hermes::HermesRuntime &rt) {
  rt.drainMicrotasks();
  while (!queue.empty() && !finished) {
    auto entry = queue.begin();
    auto due = entry->first.first;
    auto id = entry->second;
    queue.erase(entry);
    auto timer = timers.find(id);
    if (timer == timers.end()) continue;
    if (due > Clock::now()) std::this_thread::sleep_until(due);
    auto callback = std::move(timer->second.callback);
    auto interval = timer->second.interval;
    timers.erase(timer);
    if (interval >= 0) {
      auto again = callback.getFunction(rt);
      timers.emplace(id, Timer{std::move(callback), interval});
      queue.emplace(std::make_pair(Clock::now() + std::chrono::microseconds(static_cast<int64_t>(interval * 1000)), id),
                    id);
      again.call(rt);
    } else {
      callback.call(rt);
    }
    rt.drainMicrotasks();
  }
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 2) {
    std::cerr << "usage: host <bundle.js|bundle.hbc>" << std::endl;
    return 64;
  }
  std::ifstream file(argv[1], std::ios::binary);
  if (!file) {
    std::cerr << "cannot read " << argv[1] << std::endl;
    return 66;
  }
  std::string contents((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  auto runtime = facebook::hermes::makeHermesRuntime(
      ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).withES6Proxy(true).build());
  auto &rt = *runtime;
  try {
    install(rt);
    rt.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(std::move(contents)), argv[1]);
    loop(*runtime);
    auto code = rt.global().getProperty(rt, "__exitCode");
    // Abandoned timers hold JS functions: release them while the runtime still exists
    queue.clear();
    timers.clear();
    return code.isNumber() ? static_cast<int>(code.asNumber()) : 1;
  } catch (const jsi::JSError &error) {
    std::cerr << "uncaught: " << error.getMessage() << std::endl << error.getStack() << std::endl;
  } catch (const std::exception &error) {
    std::cerr << "host error: " << error.what() << std::endl;
  }
  queue.clear();
  timers.clear();
  return 70;
}
