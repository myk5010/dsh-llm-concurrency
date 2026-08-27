// Host plugin: process-wide per-provider concurrency gate for LLM streams.
// Loaded from the web profile patch layer (cordis.patch.yml insert row).
// It wraps the llm/stream waterfall result: after middleware routing settles,
// the first iteration acquires a FIFO permit for the final provider, and the
// permit is released when the stream finishes, fails, or the consumer returns.
// Providers without a configured limit pass through untouched.

function providerWaitAbort(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason)
}

/** One FIFO gate: `limit` concurrent holders, excess callers wait in order. */
class ProviderGate {
  active = 0
  waiting = []

  constructor(limit) {
    this.limit = limit
  }

  acquire(signal) {
    if (signal.aborted) return Promise.reject(providerWaitAbort(signal))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(this.releaseOnce())
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(providerWaitAbort(signal))
        },
      }
      this.waiting.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  releaseOnce() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  drain() {
    while (this.active < this.limit) {
      const waiter = this.waiting.shift()
      if (waiter === undefined) return
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(providerWaitAbort(waiter.signal))
        continue
      }
      this.active += 1
      waiter.resolve(this.releaseOnce())
    }
  }
}

function abortedFinish(error) {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: error.message, code: 'ABORTED' } },
  }
}

/** Wrap an adapter iterable so one provider permit covers dispatch to cleanup. */
function gated(iterable, gate, signal) {
  let release
  let started = false
  let failed = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (failed) return { done: true }
      if (!started) {
        started = true
        try {
          release = await gate.acquire(signal)
        } catch (error) {
          failed = true
          return { done: false, value: abortedFinish(error) }
        }
      }
      const item = await iterable.next()
      if (item.done) {
        release?.()
        release = undefined
      }
      return item
    },
    async return() {
      release?.()
      release = undefined
      return iterable.return ? iterable.return() : { done: true }
    },
    async throw(error) {
      release?.()
      release = undefined
      return iterable.throw ? iterable.throw(error) : Promise.reject(error)
    },
  }
}

export default {
  name: 'llm-concurrency',
  inject: ['llm'],
  apply(ctx, config = {}) {
    const limits = config.maxConcurrentRequests ?? {}
    const gates = new Map()
    for (const [provider, limit] of Object.entries(limits)) {
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`llm-concurrency: maxConcurrentRequests.${provider} must be a positive safe integer`)
      }
      gates.set(provider, new ProviderGate(limit))
    }
    const lifetime = new AbortController()
    ctx.effect(() => () => lifetime.abort(new Error('llm-concurrency disposed')), 'llm-concurrency: abort queued provider waits')

    ctx.on('llm/stream', (options, next) => {
      const gate = gates.get(options.provider)
      if (gate === undefined) return next()
      const iterable = next()
      const signal = options.signal === undefined
        ? lifetime.signal
        : AbortSignal.any([options.signal, lifetime.signal])
      return gated(iterable, gate, signal)
    })
  },
}
