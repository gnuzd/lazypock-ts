# SDK benchmarks

Baseline micro-benchmarks for the SDK. No server is required — the HTTP
benchmark stubs `globalThis.fetch`.

```bash
npm run bench   # builds dist/ first, then runs both scripts
```

## `codegen.mjs`

Median/p95 wall time for `generateTypes` over schemas of 5, 50, and 500
collections (index of `CollectionSchema`, output bytes included). Pure.

## `http-overhead.mjs`

Uses a stubbed `fetch` (counts calls, adds 1 ms latency) to measure:

- per-request bookkeeping on the serial path (`requestKey: null`);
- `singleFlight: true` coalescing — 50 concurrent identical requests should
  produce **1** fetch call;
- the same 50 concurrent requests without coalescing — **50** fetch calls;
- auto-cancellation map churn when the same `requestKey` is reused in a tight
  loop.

Values are indicative; run on an idle machine for comparable numbers. There
are no committed baselines yet — capture them per release if you want to track
regressions.
