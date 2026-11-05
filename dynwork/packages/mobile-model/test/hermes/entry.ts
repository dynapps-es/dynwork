// Every pure test file, run under Hermes by `../remote/script/hermes.ts --package .`. They are the same files `bun test`
// runs, except `fixtures.test.ts`, which reads directories. `#fixtures` resolves to the bundled recordings there.
import "../rules.test"
import "../reduce.test"
import "../shapes.test"
import "../scenarios.test"
import { run } from "../../../remote/test/hermes/bun-test"

void run()
