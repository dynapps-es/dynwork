// Every pure test file, run under Hermes by script/hermes.ts. They are the same files `bun test` runs.
import "../noise.test"
import "../frame.test"
import "../keys.test"
import "../session.test"
import "../mux.test"
import "../peer.test"
import { run } from "./bun-test"

void run()
