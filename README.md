# xpath-es

A modern, strictly typed XPath 1.0 engine for TypeScript and JavaScript, **work in progress**.

The goal is an engine for libraries that evaluate XPath on untrusted XML, such as XML-signature and SAML stacks:
results identical to the widely used [`xpath`](https://github.com/goto100/xpath) package, and no input that makes it
quadratic. Nothing here is published, and the API is not stable.

## Status

This repository currently holds three things:

1. **A differential harness** (`test/`) that compares any candidate XPath engine with upstream `xpath` 0.0.36, the
   oracle: random documents, a grammar-based expression fuzzer, mutation scenarios, and a corpus of the expressions
   real XML-signature and SAML libraries evaluate.
2. **A hostile-document suite** (`test/hostile.ts`, `bench/`) that runs shapes which make a naive engine superlinear
   and fails a candidate that is too slow or gives a different answer.
3. **An archival prototype** (`prototype/`): a snapshot of a measured prototype of the engine's hot paths. It is not
   wired into the checks, and its scripts are not runnable from here as they are (see `prototype/README.md`). The
   engine itself is meant to grow from it, into `src/`.

There is no engine in `src/` yet. The harness judges the [bugsee/xpath](https://github.com/bugsee/xpath) fork of
`xpath` today.

## Running it

Node >= 22.18 (the TypeScript sources run directly, by type stripping; there is no build).

```sh
npm ci
npm run check            # tsc (TypeScript 7, every strict flag), oxlint (type-aware), oxfmt --check
npm run test:harness     # the harness tests itself on candidates whose verdict is known
npm run test:differential
npm run test:hostile
npm run fixtures         # builds the signed SAML responses the benchmarks use (results/, not committed)
npm run bench:hostile    # numbers, per engine
npm run bench:consumers
npm run bench:e2e        # samlify + xml-crypto, with the candidate swapped in for xpath, and a shadow mode
```

### Choosing the candidate

`CANDIDATE` names the engine under test: a package name resolved from `node_modules`, or a path (starting with `.`
or absolute) to a CommonJS or ES module that exports the legacy `xpath` API (`select`, `select1`,
`selectWithResolver`, `parse(...)`, `evaluate`, `XNodeSet`). The default is `xpath-fork`, the
[bugsee/xpath](https://github.com/bugsee/xpath) release tarball, which is a dev dependency.

```sh
CANDIDATE=./path/to/engine.js node test/fuzz.ts xmldom08 300 1 all
CANDIDATE=xpath node test/mutation.ts        # the oracle against itself: must show no differences
```

### Scripts

| script | what it does |
|---|---|
| `test/fuzz.ts <dom> <documents> [seed] [fuzz\|all]` | random documents and the scenarios static, mutated, detached, fragment, two documents, pair ordering; `all` adds the whole corpus. Fails on any difference in members, order or attribute/namespace nodes (`TOLERATE=order,mixed` lets kinds through) |
| `test/fuzz-expr.ts <dom> <documents> <expressions> [seed] [ns] [limit ms]` | random expressions from a grammar on random documents; an evaluation that does not return in time is counted, with the engine that was running |
| `test/mutation.ts` | the document changes while a result is held, or while an expression is being evaluated by a custom function |
| `test/hostile.ts` | the hostile gate, below |
| `test/hostile-digests.ts` | records what the oracle answers on each hostile case (`baselines/oracle-digests.json`) |
| `test/harness-selftest.ts` | a candidate that reverses node-sets must be caught by the fuzzer, a quadratic one by the gate |

The DOM matrix for `<dom>`: `xmldom08` (`@xmldom/xmldom` 0.8.15, the default), `xmldom09`, `xmldom06`, `jsdom`,
`happy` (happy-dom) and `linkedom`, all dev dependencies with exact versions.

### The hostile gate and baselines

Every case of `bench/hostile-cases.ts` runs on the candidate in its own process, killed after the bound
(`HOSTILE_BOUND_MS`, default 10 000 ms, loose on purpose: good engines take milliseconds and quadratic ones minutes),
and must give the oracle's answer where `baselines/oracle-digests.json` knows it (upstream itself cannot finish some
cases, which are then judged on time only).

A candidate with known-slow shapes lists them by case name in `baselines/<candidate>.json` (or the file `BASELINE`
names). A listed case that is too slow does not fail the run and is reported; one that is within the bound is reported
so the baseline can shrink when that is stable. A wrong result or an error is never baselined. With no baseline file, or
`HOSTILE_STRICT=1`, a candidate is judged strictly. `baselines/xpath-fork.json` records what the fork is known to
be slow on.

## Not here yet

Engine-internal switches the prototype had (for example forcing every fast path off) belong to the engine phase and
are not part of the harness.

## Licence, credits and references

MIT, see `LICENSE`.

`xpath-es` is a new code base with no upstream, written from the W3C specification, and it exists because of
[`xpath`](https://github.com/goto100/xpath), whose behaviour it is measured against and whose tests and quirks it
learns from. `xpath` was originally written by **Cameron McCormack** (copyright 2018, MIT, preserved in `LICENSE`),
with contributions from **Yaron Naveh**, **goto100**, **Thomas Weinert**, **Jimmy Rishe** and
[others](https://github.com/goto100/xpath/graphs/contributors). Thank you.

- W3C, *XML Path Language (XPath) Version 1.0*, W3C Recommendation, 16 November 1999:
  <https://www.w3.org/TR/1999/REC-xpath-19991116/>
- `xpath` 0.0.36, the oracle (dev dependency): <https://github.com/goto100/xpath>, MIT.
- The [bugsee/xpath](https://github.com/bugsee/xpath) fork, judged by this harness (dev dependency): MIT, same
  copyright holders.

Other dev dependencies keep their own licences: `@xmldom/xmldom`/`xmldom` (MIT), `jsdom` (MIT), `happy-dom` (MIT),
`linkedom` (ISC), `samlify` (MIT), `xml-crypto` (MIT), `@authenio/xml-encryption` (MIT), `node-forge` (BSD-3-Clause
or GPL-2.0, used here under BSD-3-Clause), TypeScript (Apache-2.0), oxlint and oxfmt (MIT).
