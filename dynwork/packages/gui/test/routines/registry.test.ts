import { describe, expect, test } from "bun:test"
import { RoutinesBackend } from "../../src/routines/backend"
import { RoutinesDemo } from "../../src/routines/demo"
import { clock } from "./fixture"

describe("the backend registry", () => {
  test("lists backends in registration order and finds them by id", () => {
    const registry = RoutinesBackend.make()
    const time = clock()
    const local = RoutinesDemo.local(time.now)
    const farm = RoutinesDemo.remote(time.now)
    registry.register(local)
    registry.register(farm)
    expect(registry.list()).toEqual([local, farm])
    expect(registry.get(farm.id)).toBe(farm)
    expect(registry.get("nope")).toBeUndefined()
  })

  test("a backend with the same id replaces the earlier one in place, as a real backend replaces its fake", () => {
    const registry = RoutinesBackend.make()
    const time = clock()
    const fake = RoutinesDemo.remote(time.now)
    const real = RoutinesDemo.remote(time.now)
    registry.register(fake)
    registry.register(RoutinesDemo.local(time.now))
    registry.register(real)
    expect(registry.get(fake.id)).toBe(real)
    expect(registry.list()).toHaveLength(2)
  })

  test("the removal of a replaced backend leaves its replacement alone", () => {
    const registry = RoutinesBackend.make()
    const time = clock()
    const fake = RoutinesDemo.remote(time.now)
    const real = RoutinesDemo.remote(time.now)
    const removeFake = registry.register(fake)
    registry.register(real)
    removeFake()
    expect(registry.get(real.id)).toBe(real)
  })

  test("a removal takes the backend out, and listeners hear every change until they leave", () => {
    const registry = RoutinesBackend.make()
    const time = clock()
    const heard = { count: 0 }
    const leave = registry.subscribe(() => void heard.count++)
    const remove = registry.register(RoutinesDemo.local(time.now))
    expect(heard.count).toBe(1)
    remove()
    expect(registry.list()).toEqual([])
    expect(heard.count).toBe(2)
    leave()
    registry.register(RoutinesDemo.local(time.now))
    expect(heard.count).toBe(2)
  })
})

describe("failures", () => {
  test("are retryable only when unreachable", () => {
    expect(RoutinesBackend.fail("unreachable", "Offline.").retryable).toBe(true)
    expect(RoutinesBackend.fail("not-found", "No.").retryable).toBe(false)
    expect(RoutinesBackend.fail("invalid", "Bad.", { name: "Empty." }).fields).toEqual({ name: "Empty." })
    expect(RoutinesBackend.fail("quota", "Full.")).not.toHaveProperty("fields")
  })
})
