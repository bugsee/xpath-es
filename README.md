# xpath-es

A modern, strictly typed XPath 1.0 engine for TypeScript and JavaScript, **work in progress**.

The goal is an engine for libraries that evaluate XPath on untrusted XML, such as XML-signature and SAML stacks:
results identical to the widely used [`xpath`](https://github.com/goto100/xpath) package, and no input that makes it
quadratic. Nothing here is published, and the API is not stable.

## Status

This repository holds four things:

1. **The engine** (`src/`, TypeScript, strict, no `any`): a lexer, a parser to an immutable AST, a closure compiler
   and an interpreter, node-sets as sorted arrays with a one-pass document-order numbering, lazy axes, a work budget and
   a wall-clock limit on every evaluation, typed errors (`XPathError` and its subclasses), and `compat.ts`, an entry
   with upstream `xpath`'s API (`select`, `select1`, `parse`, `evaluate`, `useNamespaces`, the value classes and the
   `is*` guards). `src/index.ts` exports both. **It is not published and not yet adopted by anything**; the API is not
   stable.
2. **A differential harness** (`test/`) that compares any candidate XPath engine with upstream `xpath` 0.0.36, the
   oracle: random documents, a grammar-based expression fuzzer, mutation scenarios, and a corpus of the expressions
   real XML-signature and SAML libraries evaluate.
3. **A hostile-document suite** (`test/hostile.ts`, `bench/`) that runs shapes which make a naive engine superlinear
   and fails a candidate that is too slow or gives a different answer.

### What gates, and where the engine deliberately differs from upstream

**Supported DOMs:** `@xmldom/xmldom` >= 0.8.15 is gated (0.8.15 is its LTS and what the SAML libraries use; the 0.9
line is gated with the split below, tested with the latest 0.9.x); jsdom, happy-dom, linkedom and the browsers
(Chromium, Firefox, WebKit) are compared or smoke-tested. Older xmldom (the unscoped `xmldom` package, 0.6 and
earlier) is not supported or tested: it is unmaintained and has known vulnerabilities. The engine does not check which
DOM it is given; it takes any DOM-shaped nodes.

| DOM | Status | Gate |
|---|---|---|
| `@xmldom/xmldom` 0.8.15 (what the SAML libraries use) | **gated** | zero differences from upstream, in every scenario and for random expressions, except class 5 below (`CLASSIFY=ns-duplicate`) |
| `@xmldom/xmldom` 0.9 | **gated, split** | `CLASSIFY=all`: no difference where upstream answers and the engine answers, except class 5; every other difference must fall in a documented class, and an unclassified difference fails |
| jsdom, happy-dom, linkedom | compared, **not gating** | the nightly run reports the differences; it fails only on a crash |

The documented classes (xmldom 0.9):

- **namespace nodes** and **a context inside a removed subtree**: upstream throws
  (`Cannot read properties of null (reading 'childNodes')`), because it orders nodes with the DOM's own
  `compareDocumentPosition`, which xmldom 0.9 cannot evaluate for a detached node or for upstream's synthetic namespace
  nodes. The engine numbers the tree itself and answers.
- **a node-set spanning several trees**: upstream returns an arbitrary order; the engine throws `XPathOrderError`
  (a safe failure).
- **class 5, the namespace axis over duplicate contexts** (xmldom 0.8 and 0.9): upstream makes a new namespace-node
  object on every evaluation, so a context reached twice yields the same namespace node twice, and its node-set (or a
  `count()` of it) holds duplicates; the engine, which removes duplicates between steps, returns it once. A node-set
  holds each node once, so the engine is right by the Recommendation. The check is rigorous: the expression must
  contain `namespace::`, both engines must answer, and the engine's answer must equal that of upstream with its
  namespace nodes interned per (element, prefix) (`test/support/interned-oracle.ts`, upstream's own source with two
  creation sites changed), for node-sets and for scalars alike. No consumer (samlify, xml-crypto, xml-encryption)
  uses the namespace axis.

Why the other DOMs do not gate: upstream delegates ordering to the DOM there and inherits its defects (linkedom's
`compareDocumentPosition` is not a document order, happy-dom and jsdom misorder or drop attributes). The engine
returns true document order, and throws `XPathOrderError` for node-sets of several trees.

Other deliberate differences:

- Error *messages* differ where upstream throws an accidental `TypeError`; the engine throws typed errors.
- Every evaluation has a work budget (`DEFAULT_BUDGET`) and a time limit (`DEFAULT_TIMEOUT_MS`); both can be changed
  per evaluation (`budget`, `timeoutMs`; `0` turns one off).

## Running it

Node >= 22.18 (the TypeScript sources run directly, by type stripping; `npm run build` makes the plain JavaScript in
`dist/`, see [Build and compatibility](#build-and-compatibility)).

```sh
npm ci
npm run check            # tsc (TypeScript 7, every strict flag), oxlint (type-aware), oxfmt --check
npm run test:unit        # unit tests of the engine (node:test)
npm run build            # dist/: ES modules and CommonJS with declarations, same compiler and strict options
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
`selectWithResolver`, `parse(...)`, `evaluate`, `XNodeSet`). `CANDIDATE=./src/index.ts` judges this engine, and
`CANDIDATE=./test/support/candidate-slow.ts` the same engine with its fast paths switched off. The default is
`xpath-fork`, the [bugsee/xpath](https://github.com/bugsee/xpath) release tarball, which is a dev dependency.

```sh
CANDIDATE=./path/to/engine.js node test/fuzz.ts xmldom08 300 1 all
CANDIDATE=xpath node test/mutation.ts        # the oracle against itself: must show no differences
```

### Scripts

| script | what it does |
|---|---|
| `test/fuzz.ts <dom> <documents> [seed] [fuzz\|all]` | random documents and the scenarios static, mutated, detached, fragment, two documents, pair ordering; `all` adds the whole corpus. Fails on any difference in members, order or attribute/namespace nodes (`TOLERATE=order,mixed` lets kinds through; `CLASSIFY=all` is the split gate for xmldom 0.9 and `CLASSIFY=ns-duplicate` allows class 5 only, above) |
| `test/fuzz-expr.ts <dom> <documents> <expressions> [seed] [ns] [limit ms]` | random expressions from a grammar on random documents; an evaluation that does not return in time is counted, with the engine that was running |
| `test/mutation.ts` | the document changes while a result is held, or while an expression is being evaluated by a custom function |
| `test/hostile.ts` | the hostile gate, below |
| `test/hostile-digests.ts` | records what the oracle answers on each hostile case (`baselines/oracle-digests.json`) |
| `test/harness-selftest.ts` | a candidate that reverses node-sets must be caught by the fuzzer, a quadratic one by the gate |

The DOM matrix for `<dom>`: `xmldom08` (`@xmldom/xmldom` 0.8.15, the default), `xmldom09` (`@xmldom/xmldom` 0.9.x), `jsdom`,
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

## Build and compatibility

`npm run build` compiles `src/` to plain JavaScript with the same compiler and the same strict options as the type
check (every strict flag, no `any`). The package is not published; this is what it would ship.

```
dist/index.js     index.d.ts     ES modules (and one .js / .d.ts per source module, flat in dist/)
dist/index.cjs    index.d.cts    CommonJS (the same modules as .cjs / .d.cts)
dist/*.js.map  dist/*.cjs.map    source maps with the sources inlined
```

- **ES2022, not down-levelled.** Classes, `#private` members, class fields and optional chaining are emitted as
  written. The emitted files contain no TypeScript syntax and do not need Node's type stripping. The sources are
  compiled against the ES2022 library only (no Node and no DOM typings), so they cannot use a newer API, and nothing
  from Node's typings reaches the `.d.ts` files.
- **Node >= 20** and recent browsers (`engines.node` is `>=20`). Developing in this repository, which runs the
  TypeScript sources and tests directly, needs Node >= 22.18.
- **`package.json`:** an `exports` map (`types` / `import` / `require`, so a TypeScript consumer gets `index.d.ts` or
  `index.d.cts`), `main`, `module`, `types`, `files` (only `dist/`, the licence and this readme are packed) and
  `"sideEffects": false`.
- **Browser-safe.** The code imports nothing from Node (no `node:` modules, no packages); the ES module entry is the
  browser entry. The time limit reads `globalThis.performance.now()` and falls back to `Date.now()` where there is
  no `performance` object.
- **Declarations** are emitted without declaration maps: the maps would point at sources that are not shipped.

What checks it, on the built output rather than the sources (`npm run build`, then):

| check | command |
|---|---|
| exports through `import` and `require`, the same names from both, the time limit without `performance`; the emitted files parse as ES2022 (acorn), keep their classes, `#private` members and `?.`, contain no TypeScript and no Node import; the declarations have no Node reference; `npm pack --dry-run` content | `npm run test:dist` |
| a TypeScript consumer (ES2022 + DOM libraries, no Node typings) compiles against the declarations for both conditions | `npm run test:dist:types` |
| unit tests, a reduced differential gate (xmldom 0.8 and 0.9, mutation, random expressions) and the strict hostile gate, with the candidate pointed at `dist/index.cjs`, on the tests compiled to JavaScript (`npm run build:tests`) | `npm run test:built` |
| real browsers (Playwright: Chromium, Firefox, WebKit): expressions on `DOMParser` documents including namespaces, an HTML document and the budget and time-limit errors, and the same expressions through upstream `xpath` compared in the page | `npx playwright install chromium && npm run test:browser` |

CI runs the first three on Node 20, 22 and 24 and the browser check on all three engines (WebKit is reported but does
not block while the runners cannot install its system libraries from apt). WebKit is Playwright's build, not Safari
itself, and no real mobile browser is tested.

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
