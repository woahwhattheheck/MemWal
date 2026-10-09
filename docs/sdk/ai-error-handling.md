# Observing AI middleware failures

`withMemWal` keeps memory I/O from breaking the model response, but memory
failures must remain observable. The optional `onMemoryError` callback receives
`{ operation: "recall" | "autoSave", error }`. Without it, the middleware emits a
content-free warning, including when `debug` is false. The callback may be async;
a callback failure produces a generic warning rather than an unhandled rejection.
Do not forward raw error objects into public logs: they may contain application
data or relayer details.

```ts
const model = withMemWal(baseModel, {
    key, accountId, namespace,
    onMemoryError({ operation }) {
        metrics.increment("memory.operation_failed", { operation });
    },
});

await generateText({ model, prompt: "I prefer tea." });
try {
    await model.flush();
} catch (error) {
    // MemWalAutoSaveError: failureCount plus the first original error in cause.
    // Inspect transport status and existing jobs before deciding to retry.
    metrics.increment("memory.flush_failed");
}
```

## Flush semantics

Call `flush()` after the model operation has started its auto-saves. It waits
for currently pending `analyze()` requests and reports recorded failures even
when those requests rejected before the flush began. A failure is consumed once;
a later flush with no new failures resolves. Failure bookkeeping retains a count
and one cause, not an unbounded list of error objects.

For streaming, call flush after consuming the stream (or after stream startup
has definitely invoked the middleware), in a runtime-supported request lifetime
hook when necessary. Flushing before starting the model operation cannot wait
for work that has not started yet.

**A successful flush confirms analyze request acceptance, not durable Walrus
storage.** The relayer completes the returned jobs asynchronously. Applications
that need confirmed storage should use the explicit `analyzeAndWait` path and
inspect terminal job outcomes. This patch does not automatically retry failed
writes: a transport timeout can hide an already-accepted request, so blindly
retrying could duplicate extraction or spend.

## Tool continuations

Auto-save runs only when the model prompt ends with user input. An assistant or
tool continuation does not re-analyze the same earlier user message. Generate
and stream hooks share this rule. Equal text in a later independent user turn
still starts a save; there is no process-wide text-based suppression.

Recall still runs for every model step so the current step receives its memory
context. This addresses the repeated-write part of issue #1079, not its repeated
recall requests. No cross-user or stale-context cache is introduced.

## Focused validation

After building `packages/sdk`, run:

```sh
node --test packages/sdk/test/middleware-failures.test.mjs
```

The six tests exercise the real compiled middleware hooks with doubles for the
AI wrapping boundary and the MemWal client. They do not invoke a model provider,
a live relayer, SEAL, or a paid write. They cover settled save failures, recall
failure callbacks, safe diagnostics and callback rejection, tool-continuation
save suppression, pending flush behavior, and the existing recall trust boundary.
