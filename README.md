# dsh-llm-concurrency

Process-wide per-provider concurrency gate for DeepSeek Harness LLM streams.

## Why

One provider account can serve model calls from every session, subagent, workflow worker, title generator, and direct LLM consumer in a DSH Host process. Without a process-wide gate, their aggregate can exceed the provider account's concurrent-request quota and surface as `Concurrency limit exceeded for user, please retry later`.

## How it works

- Registers an `llm/stream` waterfall listener.
- After middleware routing settles, wraps the final adapter iterable.
- The first iteration acquires a FIFO permit for the **final** provider (the one the request actually dispatches to).
- The permit is released on stream finish, failure, consumer early return, or cancellation.
- Cancelling a queued request removes its waiter immediately; no provider request is made and no retry budget is consumed.
- Providers without a configured limit pass through untouched.

## Install

Copy `llm-concurrency.mjs` into your DSH profile directory, then add a patch row to `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-concurrency
      name: ./llm-concurrency.mjs
      config:
        maxConcurrentRequests:
          luna-relay: 3
```

Restart `dsh web`, then confirm the effective composition:

```bash
dsh --profile web --dump-config | tail
```

The `luna-relay` provider is now capped at 3 simultaneously active streams in this Host process; excess calls wait FIFO instead of failing.

## Behavior notes

- FIFO across all sessions and Host LLM consumers; no priority classes.
- The limit is process-local: other Host processes sharing the same account are not coordinated by this plugin.
- A permit covers adapter dispatch through iterator cleanup.
- Prepared calls and direct streams share the same provider queue.
- Lowering a limit never interrupts already-active streams.

## Requirements

- DeepSeek Harness with the `llm/stream` waterfall signature `(options, next) => AsyncIterable` (current versions).
- Node.js with `AbortSignal` (Node 18+).

## License

MIT
