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

| DOM | Status | Gate |
|---|---|---|
| `@xmldom/xmldom` 0.8 (what the SAML libraries use) | **gated** | zero differences from upstream, in every scenario and for random expressions, except class 5 below (`CLASSIFY=ns-duplicate`) |
| `@xmldom/xmldom` 0.9 | **gated, split** | `CLASSIFY=all`: no difference where upstream answers and the engine answers, except class 5; every other difference must fall in a documented class, and an unclassified difference fails |
| xmldom 0.6, jsdom, happy-dom, linkedom | compared, **not gating** | the nightly run reports the differences; it fails only on a crash |

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
`compareDocumentPosition` is not a document order, happy-dom and jsdom misorder or drop attributes), and xmldom 0.6
leaves `parentNode` set on a removed node. The engine returns true document order, and throws `XPathOrderError` for
node-sets of several trees and for a context in a removed xmldom 0.6 subtree.

Other deliberate differences:

- Error *messages* differ where upstream throws an accidental `TypeError`; the engine throws typed errors.
- Every evaluation has a work budget (`DEFAULT_BUDGET`) and a time limit (`DEFAULT_TIMEOUT_MS`); both can be changed
  per evaluation (`budget`, `timeoutMs`; `0` turns one off).

## Running it

Node >= 22.18 (the TypeScript sources run directly, by type stripping; `npm run build` makes `dist/esm` and
`dist/cjs`).

```sh
npm ci
npm run check            # tsc (TypeScript 7, every strict flag), oxlint (type-aware), oxfmt --check
npm run test:unit        # unit tests of the engine (node:test)
npm run build            # dist/esm and dist/cjs, same compiler and strict options
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
