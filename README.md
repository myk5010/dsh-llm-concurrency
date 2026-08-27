# dsh-llm-concurrency

English | [中文](README.zh.md)

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

## Where does `luna-relay` come from

`luna-relay` is not a provider this plugin ships. It is a **configurable provider route** activated by the pi-ai adapter (`@deepseek-ai/dsh-llm-pi-ai`) through DSH settings — in `~/.dsh/settings.yaml` under `llm-pi-ai.providers`. In the example below it points at an OpenAI-compatible relay endpoint; the API key is read from the environment variable named by `apiKeyEnv`:

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    luna-relay:
      displayName: OpenaiRelay
      apiKeyEnv: DSH_RELAY_API_KEY
      api: openai-completions
      baseURL: https://your-relay.example.com/v1
      reasoning: xhigh
      models:
        - id: gpt-5.6-luna
          name: GPT-5.6 Luna
          contextWindow: 272000
          maxTokens: 128000
```

The plugin only needs the **provider name** to match. Two files work together:

1. `settings.yaml` declares the route (`luna-relay` → endpoint, models, key env).
2. `cordis.patch.yml` applies the concurrency limit to that same name.

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: llm-concurrency
      name: ./llm-concurrency.mjs
      config:
        maxConcurrentRequests:
          luna-relay: 3
```

Replace `luna-relay` with any provider name from your own settings (e.g. `deepseek-official`) to cap it the same way.

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
