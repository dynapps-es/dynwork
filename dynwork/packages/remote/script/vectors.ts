#!/usr/bin/env bun
// Regenerates test/fixtures/noise-vectors.json from the published Noise test vectors: every
// `Noise_XX_25519_ChaChaPoly_SHA256` and `Noise_IK_25519_ChaChaPoly_SHA256` vector (no PSK) of the three public suites,
// each file pinned by commit and SHA-256 so the fixture can be audited against its source.
//
//   bun script/vectors.ts

const sources = [
  {
    name: "cacophony",
    url: "https://raw.githubusercontent.com/haskell-cryptography/cacophony/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt",
    sha256: "3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae",
  },
  {
    name: "snow",
    url: "https://raw.githubusercontent.com/mcginty/snow/8ac60f51cfe3e010c84f0a454cc575ad9204fa12/tests/vectors/snow.txt",
    sha256: "69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3",
  },
  {
    name: "noise-c",
    url: "https://raw.githubusercontent.com/rweather/noise-c/cfe25410979a87391bb9ac8d4d4bef64e9f268c6/tests/vector/noise-c-basic.txt",
    sha256: "e826749cf90efda26be85410381f4b1f75552c61c7c0dcad7f9ffb4d639e4e45",
  },
]

const protocols = ["Noise_XX_25519_ChaChaPoly_SHA256", "Noise_IK_25519_ChaChaPoly_SHA256"]

type Raw = Record<string, unknown> & { messages: { payload: string; ciphertext: string }[] }

const vectors = await Promise.all(
  sources.map(async (source) => {
    const text = await fetch(source.url).then((response) => {
      if (!response.ok) throw new Error(`${source.url}: ${response.status}`)
      return response.text()
    })
    const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    if (digest !== source.sha256) throw new Error(`${source.name}: sha256 ${digest}, expected ${source.sha256}`)
    const raw: Raw[] = JSON.parse(text).vectors
    return raw
      .filter((vector) => protocols.includes(String(vector.protocol_name ?? vector.name)))
      .filter((vector) => !Array.isArray(vector.init_psks) || vector.init_psks.length === 0)
      .map((vector) => ({
        source: source.name,
        protocol: String(vector.protocol_name ?? vector.name),
        init_prologue: String(vector.init_prologue),
        init_static: String(vector.init_static),
        init_ephemeral: String(vector.init_ephemeral),
        init_remote_static: vector.init_remote_static === undefined ? undefined : String(vector.init_remote_static),
        resp_prologue: String(vector.resp_prologue),
        resp_static: String(vector.resp_static),
        resp_ephemeral: String(vector.resp_ephemeral),
        handshake_hash: vector.handshake_hash === undefined ? undefined : String(vector.handshake_hash),
        messages: vector.messages.map((message) => ({ payload: message.payload, ciphertext: message.ciphertext })),
      }))
  }),
)

const out = new URL("../test/fixtures/noise-vectors.json", import.meta.url)
await Bun.write(out, JSON.stringify({ sources, vectors: vectors.flat() }, null, 2) + "\n")
console.log(`wrote ${vectors.flat().length} vectors to ${out.pathname}`)
