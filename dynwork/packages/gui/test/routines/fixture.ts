// A clock the test moves, for the fakes: nothing in the routines waits on real time.
export function clock(start = Date.UTC(2026, 10, 16, 9, 0)) {
  const time = { value: start }
  return {
    now: () => time.value,
    advance: (ms: number) => {
      time.value += ms
    },
  }
}

export const MINUTE = 60_000

// Lets the promise chains of in-memory backends run to their end.
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
