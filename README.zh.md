# dsh-llm-concurrency

[English](README.md) | 中文

面向 DeepSeek Harness LLM 流的进程级、按 Provider 并发门控插件。

## 为什么需要

一个 Provider 账号会承载同一 DSH Host 进程中所有 session、subagent、workflow worker、标题生成器和直接 LLM 消费方的模型调用。没有进程级门控时，它们的总量可能超过 Provider 账号的并发请求配额，表现为 `Concurrency limit exceeded for user, please retry later`。

## 工作原理

- 注册一个 `llm/stream` waterfall listener。
- middleware 路由完成后，包装最终的 adapter iterable。
- 首次迭代时为**最终** Provider（请求实际分派到的那个）获取 FIFO permit。
- permit 在流结束、失败、消费方提前返回或取消时释放。
- 取消排队中的请求会立即移除其 waiter；不会向 Provider 发起请求，也不消耗重试预算。
- 未配置上限的 Provider 原样放行。

## 安装

把 `llm-concurrency.mjs` 复制到 DSH profile 目录，然后在 `cordis.patch.yml` 添加一行：

```yaml
- insert:
    - id: llm-concurrency
      name: ./llm-concurrency.mjs
      config:
        maxConcurrentRequests:
          luna-relay: 3
```

重启 `dsh web`，然后确认有效 composition：

```bash
dsh --profile web --dump-config | tail
```

此时 `luna-relay` 在该 Host 进程中最多同时有 3 条活动流；超出的调用按 FIFO 等待而不是失败。

## 行为说明

- 所有 session 和 Host LLM consumer 之间严格 FIFO，不设优先级类别。
- 限制是进程本地的：共享同一账号的其他 Host 进程不受本插件协调。
- permit 覆盖 adapter dispatch 直到 iterator cleanup。
- prepared call 与直接 stream 共享同一个 Provider 队列。
- 调低上限不会中断已活动的流。

## 要求

- DeepSeek Harness，且 `llm/stream` waterfall 签名为 `(options, next) => AsyncIterable`（当前版本）。
- Node.js 支持 `AbortSignal`（Node 18+）。

## 许可证

MIT
