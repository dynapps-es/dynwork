#!/usr/bin/env bun
// `bun run test:hermes`: runs the pure tests under the Hermes engine React Native 0.88 ships.
//
// npm carries no Hermes VM: `hermes-compiler` (the version RN 0.88.1 pins) is only `hermesc`, which compiles and
// refuses to execute. The VM is the `hermesvm` framework RN's `hermes-engine` pod downloads for that same version from
// Maven Central; its macOS slice runs here inside a small JSI host (script/hermes/host.cpp). So:
//   1. check src for what Hermes lacks (`node:` imports, Bun APIs, WebAssembly);
//   2. bundle test/hermes/entry.ts with esbuild, `bun:test` replaced by test/hermes/bun-test.ts;
//   3. lower what React Native 0.88's Babel preset lowers for Hermes by default (`@react-native/babel-preset`,
//      hermes-stable profile): block scoping and private members. Hermes gives `let`/`const` function scope unless
//      they are lowered, so a closure in a loop would see the last iteration's binding (Effect relies on per-iteration
//      bindings in its concurrent `forEach`);
//   4. compile the result to Hermes bytecode with the npm `hermesc`, as an RN release build does;
//   5. run the bytecode in the host. Any failure, or a run that does not finish, is a red exit.
//
// macOS only (the host links the macOS framework). Elsewhere it fails rather than skipping.

import { $ } from "bun"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { transformAsync } from "@babel/core"
import { build } from "esbuild"

const version = "260318099.0.5"
const artifact = {
  url: `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/${version}/hermes-ios-${version}-hermes-ios-debug.tar.gz`,
  sha256: "c92c147a668e3349b041f27e457859e80d50512dc0aa4d9241987b4c64675625",
}

const root = path.resolve(import.meta.dir, "..")
const fail = (message: string): never => {
  console.error(`test:hermes: ${message}`)
  process.exit(1)
}

if (process.platform !== "darwin") fail("needs macOS: the host links the macOS slice of hermesvm.framework")

// 1. What would not run on Hermes
const forbidden = [/from "node:/, /\bBun\./, /\bWebAssembly\b/, /\bprocess\./, /\brequire\(/]
for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root })) {
  const text = await Bun.file(path.join(root, file)).text()
  const hit = forbidden.find((pattern) => pattern.test(text))
  if (hit) fail(`${file} uses ${hit}, which Hermes does not have`)
}

// 2. hermesc from npm, the version React Native 0.88.1 pins
const compiler = path.join(root, "node_modules/hermes-compiler")
const pinned = (await Bun.file(path.join(compiler, "package.json")).json()).version
if (pinned !== version) fail(`hermes-compiler is ${pinned}, expected ${version} (React Native 0.88.1)`)
const hermesc = path.join(compiler, "hermesc/osx-bin/hermesc")

// 3. The VM, cached per version, and the host built against it
const cache = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
  "dynwork-remote",
  "hermes",
  version,
)
const frameworks = path.join(cache, "destroot/Library/Frameworks/macosx")
if (!(await Bun.file(path.join(frameworks, "hermesvm.framework/hermesvm")).exists())) {
  await mkdir(cache, { recursive: true })
  console.log(`test:hermes: downloading ${artifact.url}`)
  const response = await fetch(artifact.url)
  if (!response.ok) fail(`download failed: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (digest !== artifact.sha256) fail(`artifact sha256 ${digest}, expected ${artifact.sha256}`)
  const tarball = path.join(cache, "hermes-ios.tar.gz")
  await Bun.write(tarball, bytes)
  await $`tar -xzf ${tarball} -C ${cache} ./destroot/include ./destroot/Library/Frameworks/macosx`.quiet()
}
const source = path.join(root, "script/hermes/host.cpp")
const hostHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(source).text())
  .digest("hex")
  .slice(0, 16)
const host = path.join(cache, `host-${hostHash}`)
if (!(await Bun.file(host).exists()))
  await $`xcrun clang++ -std=c++20 -O2 -I${path.join(cache, "destroot/include")} -F${frameworks} -framework hermesvm -Wl,-rpath,${frameworks} ${source} -o ${host}`

// 4. Bundle, lower as Metro does, compile, run
const out = path.join(root, "node_modules/.cache/hermes")
await mkdir(out, { recursive: true })
const bundle = path.join(out, "tests.js")
await build({
  entryPoints: [path.join(root, "test/hermes/entry.ts")],
  bundle: true,
  outfile: bundle,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  target: "es2022",
  // Hermes compiles neither async generators nor `for await`
  supported: { "async-generator": false, "for-await": false },
  alias: { "bun:test": path.join(root, "test/hermes/bun-test.ts") },
  logLevel: "warning",
})
const lowered = await transformAsync(await Bun.file(bundle).text(), {
  babelrc: false,
  configFile: false,
  compact: true,
  plugins: [
    "@babel/plugin-transform-block-scoping",
    ["@babel/plugin-transform-private-methods", { loose: true }],
    ["@babel/plugin-transform-private-property-in-object", { loose: true }],
  ],
})
if (!lowered?.code) fail("babel produced no output")
const metro = path.join(out, "tests.metro.js")
await Bun.write(metro, lowered.code)
const bytecode = path.join(out, "tests.hbc")
// hermesc warns about every global the bundle reads (`print`, `crypto`...), echoing the minified line; keep it quiet
await $`${hermesc} -O -emit-binary -out ${bytecode} ${metro}`.quiet()
console.log(`test:hermes: Hermes ${version} (React Native 0.88.1), bytecode from npm hermesc`)
const run = Bun.spawn([host, bytecode], { stdout: "inherit", stderr: "inherit" })
process.exit(await run.exited)
