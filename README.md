# xpath-es

A modern, strictly typed XPath 1.0 engine for TypeScript and JavaScript, **work in progress**.

The goal is an engine for libraries that evaluate XPath on untrusted XML, such as XML-signature and SAML stacks: the
Recommendation's answers by default (`strict` mode, with the deviations listed below), the answers of the widely used
[`xpath`](https://github.com/goto100/xpath) package on request (`upstream` mode), and bounded work on hostile input: every
evaluation has a work budget and a time limit, and an input that would need more is refused with a typed error. Some
expressions are inherently quadratic on some documents (see [Limits](#limits)); the engine refuses those rather than
running them. Nothing here is published, and the API is not stable.

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

Other deliberate differences from upstream, in either mode:

- Error *messages* differ where upstream throws an accidental `TypeError` or `ReferenceError`; the engine throws typed
  errors, and the fuzzers compare the *category* of two errors (syntax, unresolvable name, type, no document order,
  limit), not the text.
- **Class 6, the limits.** The engine stops an evaluation at its default work budget or time limit (below); upstream
  would have gone on. When that is the only difference, the fuzzers re-run the engine with the limits off and require
  upstream's answer exactly (`test/support/classify.ts`, `isLimitPolicy`). The expressions this happens to are
  quadratic or worse on a document with a parent of thousands of children.
- Plain-object resolver maps (`namespaces`, `functions`, `variables`) are read by own property only: a prefix called
  `constructor`, or a function called `toString`, is not a member of `Object.prototype`.
- In upstream mode a namespace resolver (a function) is asked at every name test, as upstream asks it, but it must not
  change the document; a plain map (`useNamespaces`) is data and costs nothing. In strict mode each prefix is asked once
  per evaluation, before anything is walked (section 1: the declarations of the expression context are fixed), so a
  resolver never runs during the walk and the one-pass axes stay on. Custom functions and variable resolvers may: the engine drops the numbering and the sibling ranks it made
  when one has run, and orders a handful of nodes locally in the meantime (`FEW_NODES` in `src/order.ts`).
- Document-only subexpressions (no context node, no position, no variable, no function the engine does not know) are
  evaluated once per document: `//a[//b[//c]]` computes `//b[//c]` once, not once per `a`.

## Modes: upstream and strict

`new XPathProgram(source, { mode })`, `select(expression, node, false, { mode })`, `parse(expression, { mode })` and the
`mode` option of the evaluator take `'strict'` (the default) or `'upstream'`.

- **`upstream`** (opt in with `mode: 'upstream'`) is the adoption gate: the node-sets and the values existing consumers (samlify, xml-crypto,
  xml-encryption) have always seen from `xpath` 0.0.36, quirks included.
- **`strict`** (the default) follows the Recommendation (16 November 1999), except where [the list below](#where-strict-mode-differs-from-the-recommendation)
  says otherwise. Its answers are checked against the text of the Recommendation (`test/unit/strict-spec.test.ts`,
  `test/unit/strict-conformance.test.ts`), against an independent reference evaluator written from the Recommendation
  that shares no code with the engine (`test/strict-oracle.ts`, random documents and location paths, on xmldom 0.8 and
  0.9 in CI and on jsdom, happy-dom and linkedom in the nightly run), never against upstream; and
  `test/mode-agreement.ts` checks that on every random expression that uses none of the deviating features the two
  modes agree, so strict mode does not regress where upstream is right.

### Known deviations from XPath 1.0 inherited from upstream (`upstream` mode)

Each one is pinned in both modes in `test/unit/modes.test.ts`.

| | `upstream` mode | `strict` mode (default) |
|---|---|---|
| `following::` (2.2) | includes the context node's descendants and, when it has children, leaves out its following siblings; `/r/a[1]/following::e` finds nothing | not the descendants; the following siblings of the node and of each ancestor with their subtrees (for an attribute or namespace node, its element's children too) |
| `preceding::` (2.2) | includes the ancestors and the document node | excludes ancestors; an attribute or namespace node stands where its element stands |
| `id()` (4.1) | asks the DOM's `getElementById` for each token (a node-set argument is joined as the nodes' serialisations: `id(//@ref)` names nothing) | the tokens of each node's string-value; at most one element per distinct token, the first in document order, from one index per evaluation |
| name tests (2.3) | case-insensitive wherever the DOM answers `implementation.hasFeature('HTML', '2.0')` with true, which xmldom, jsdom and browsers do for every document: `//E` finds `<e/>` in an XML document | case-sensitive in an XML document; case-insensitive in an HTML document (`contentType` `text/html`) |
| `@*`, `attribute::*` (5.3) | include `xmlns` / `xmlns:p` declarations | namespace declarations are not attributes |
| `lang()` (4.3) | the context node's own `xml:lang` on a DOM that answers `''` for a missing attribute (xmldom), the ancestors' otherwise; case-sensitive | the nearest ancestor-or-self `xml:lang`, ignoring case, with `-` sublanguages |
| `number()` of a node-set (4.4) | through JavaScript's `Number()`: an empty node-set is 0, `0x10` is 16 | the string-value of the first node, converted by the grammar: an empty node-set is NaN |
| string to number (4.4) | `1.` is NaN; white space is JavaScript's (a no-break space is trimmed) | the grammar of 4.4: `1.` and `.5` are numbers, `+1`, `1e3`, `0x10`, a lone `.` are NaN; only space, tab, CR and LF around it |
| number to string (4.2) | small numbers are written by padding digits and the sign goes wrong: `string(-0.00000001)` is `0.0000000-1` | no exponent, the sign kept: `-0.00000001`; both zeros print `0` |
| `substring()` (4.2) | JavaScript's `substring()` on rounded bounds: reversed bounds swap, NaN is 0: `substring("12345", 3, -1)` is `2`, `substring("12345", 0 div 0)` is `12345` | positions `round(start)` up to `round(start) + round(length)`, NaN gives the empty string, infinities clamp |
| `string-length()`, `substring()` (4.2) | UTF-16 code units | characters |
| namespace axis (5.4) | each evaluation makes new node objects, so a context reached twice yields a namespace node twice (class 5); `xmlns=""` makes a node; a namespace node has no parent | one node per element and prefix, held once; no node for `xmlns=""`; the parent is the element |
| axis names, NUL (3.7) | an unknown axis name selects nothing (`foo::bar` is `[]`); a NUL ends the expression | a syntax error |
| an unresolvable prefix (2.3) | an error only when a node test meets a node: `//e[count(following-sibling::p:x)=0]` is fine when `e` has no following sibling | an error whenever the expression is evaluated |
| the `xml` prefix (2.3) | unresolved unless the resolver knows it | bound to `http://www.w3.org/XML/1998/namespace` without a declaration: `//@xml:lang` works with no resolver |
| principal node type (2.3) | `*` and a name test accept attributes, elements and namespace nodes on every axis: `@x/self::*` finds `@x`, `count(//@x/descendant-or-self::*)` counts the attribute | the principal node type of the axis: attributes on `attribute::`, namespace nodes on `namespace::`, elements on every other |
| `node()` (2.3) | rejects namespace nodes and a document fragment | accepts every node of the data model: namespace nodes, a document fragment (the root of a detached tree) |
| namespace axis order (5.4) | two inherited bindings cannot be ordered: `//b/namespace::*`, `//namespace::*` and `count(//b/namespace::*[name()="xml"])` throw `XPathOrderError` (class 5) | in document order: `xml`, the element's own declarations, then those inherited from its parent outwards; an element, then its namespace nodes, then its attributes |
| a boolean and a node-set (3.4) | `false() < //b` compares the boolean, as a number, with each node's number (a boolean on the right converts the node-set to a boolean) | both orders convert the node-set to a boolean |
| `local-name()` (4.1) | falls back to the node's name: `#text`, `#document`, `#comment` | empty for a node without an expanded name; only an element, attribute, processing instruction or namespace node has one |
| white space and numbers (3.7) | none between a name and `(` or `::` (`count (//a)` is a syntax error), `1.` is not a number, `,` and `$` do not make `*`, `div` an operand (`concat("x", *)`, `$div`) | all of them are lexed as the grammar says |
| text nodes (5.7) | one node per DOM Text or CDATASection node: `<a>x<![CDATA[cd]]>w</a>` has three `text()` nodes, and `string(//a/text())` is `x` | one text node per run of adjacent Text and CDATASection siblings, represented by the first DOM node of the run, whose string-value is the whole run: one `text()` node, `string(//a/text())` is `xcdw` |
| the XML declaration (5) | some DOMs (xmldom) keep it as a processing instruction child of the document: `count(/processing-instruction())` is 1 for `<?xml version="1.0"?><a/>` | not a node |
| `/` (2) | the owner document, even of a detached element | the root of the tree that contains the context node: for a detached element or a document fragment, its topmost ancestor |
| `translate()`, `contains()`, `starts-with()`, `substring-before()`, `substring-after()` (4.2) | UTF-16 code units: `translate("😀", "😁", "x")` is `x` followed by a lone surrogate | characters; a match cannot begin or end inside a surrogate pair |

**`id()` cannot detect duplicate IDs in either mode.** When two elements have the same ID, `id()` answers the first in
the order the DOM looks up (document order for the DOMs tested); the Recommendation leaves duplicates undefined, and
Blink, WebKit and Gecko answer the first as well. The ID attributes are `id` and, in strict mode, `xml:id`.

Strict is the default, so code written against `xpath` that relied on a quirk above must ask for `mode: 'upstream'`.

### Where strict mode differs from the Recommendation

Strict mode is the Recommendation except for these, each a choice or a limit and none an accident:

- **An HTML document** (`contentType` `text/html`) matches names without regard to case, as HTML does; an XML document never does.
- **Text nodes are represented by DOM nodes.** `text()` yields one node per run of adjacent Text and CDATASection siblings, and
  that node is the first DOM node of the run, so identity, document order and node-set semantics stay those of the DOM. The
  string-value (`string()`, `=`, `contains()`, `sum()`) is the whole run. Code that takes the selected DOM node and reads its own
  `nodeValue` or `data` sees the first piece only. This matters for signed values: a NameID `victim@example.test` with a CDATA
  tail `.evil.test` canonicalises to the same bytes as the same text without CDATA; strict mode reads it in full through
  `string()`, where `upstream` mode's `string(//NameID/text())` is only the first piece.
- **The order of namespace nodes** within an element is not specified by the Recommendation; strict mode orders them as the
  table says.
- **DocumentType, Entity, EntityReference and Notation nodes** are not nodes of the model: a node test never selects them.
- **`id()`** answers one element per token, the first in document order; duplicate IDs are not detected. The ID attributes are
  `id` and `xml:id`.
- **Limits** (below) refuse an evaluation that needs more than the work budget or the time limit, which the Recommendation
  does not know of.
- **Predicates other than `[k]` and `[last()]` after `following::` or `preceding::`** are evaluated for each context node, as
  the Recommendation defines them; they are not made linear (below).

**A difference between the modes on the signature path.** A SAML consumer looks for the element that carries the signed ID with
an expression such as `//*[@*[local-name(.)='ID']='<id>']`. In `upstream` mode (and in `xpath` itself) an element that only
declares `xmlns:ID="<id>"` also matches, because upstream lists namespace declarations as attributes; in strict mode it does
not (section 5.3: a declaration is not an attribute). A response that carries such a decoy next to the signed element is
therefore rejected by a consumer in `upstream` mode (two matches) and accepted in strict mode (one match, the signed
element). `test/unit/strict-conformance.test.ts` pins both behaviours.

Cost: strict `following::` and `preceding::` are linear over a node-set of contexts when there is no positional predicate and
when `[k]` or `[last()]` is the first predicate; other positional predicates are not. Without a positional predicate they
are one pass over the tree (`preceding::` of a set is everything before the last context that is not an ancestor of it).
With `[k]` or `[last()]` as the first predicate they are one pass over the tree, then a lookup per context node by
document-order number (a binary search; the ancestors of each context are kept on a stack while the contexts are taken
in document order), so that the position stays relative to each context's own axis. `//b/preceding::*` over 3,000 `b`
elements takes 21,000 units (it took 9 million), `//a/following::b[1]` 63,000. A predicate that is positional in another
way (`[position() < 3]`, `[last() - 1]`, a positional predicate that is not the first) is still evaluated per context node
and costs a walk of the axis for each, so it can reach the budget over thousands of contexts; raise the budget for such a call.

## Limits

Every evaluation has a work budget and a time limit, so that an expression on a hostile document stops with a typed
error (`XPathBudgetError`, code `BUDGET`; `XPathTimeoutError`, code `TIMEOUT`; `XPathLimitError`, code `LIMIT`) instead
of running for minutes. A *unit* is a node visited, a node-set member sorted, one evaluation of a predicate, an operand of a boolean, arithmetic or
comparison chain, a function call or a variable, or (for string functions) sixteen characters scanned.

| | default | measured |
|---|---|---|
| `DEFAULT_BUDGET` | 5,000,000 units | the most one evaluation of a signed SAML login response took was **14,232** units, for a response with a 2,000-value group list (7 units per value, about 1 ms); the hostile documents of the gate (256 KiB each) take at most **328,000** units (18 ms). The default is 350 times the first and 15 times the second. A hostile expression is stopped after at most 5,000,000 units: 49 ms for `//*` with 20,000 predicates `[1=1]` on 100,000 nodes (it ran 25 s before predicate evaluations were counted), up to the time limit where a unit costs more |
| `DEFAULT_TIMEOUT_MS` | 1,000 ms | the backstop for work the units do not model; the clock is read every 4,096 units and every 512 charges, so work that charges little cannot keep the limit from being looked at |
| namespace nodes | 262,144 per evaluation | a document nested 8,000 levels deep with a new prefix at every level made 32 million nodes (4 GB) before |
| `id()` | 10,000 distinct tokens per call | 40,000 tokens took 39 s before |
| strings | 16,777,216 characters per string | nested `concat()` doubled a string per level |

They apply to every entry: `XPathProgram.run`, `select`, `select1`, `selectWithResolver`, `useNamespaces` (as
`{ budget, timeoutMs }`, also as defaults: `useNamespaces(map, { budget })`) and the evaluator object. `0` turns a limit
off, `Infinity` works as well; anything that is not a number of at least 0 (a string such as `'0'`, `NaN`, `null`, a
negative number) is refused with `XPathContextError`, because it would otherwise turn the limit off silently.
`bench/limits.ts` prints the measurements. A caller whose legitimate documents are larger raises the limits.

The parse cache of the compat entry is a byte-bounded LRU (an estimate of 16 MiB retained in all, at 512 bytes per character
of source, and 512 programs) and does not keep an expression longer than 2,048 characters.

Some expressions stay expensive on some documents, and the limits refuse them: `//a[count(preceding::a)=1]` over 50,000
siblings, a union of 20,000 named steps, and a predicate such as `following::*[position() < 3]` over thousands of contexts.
Raise the budget for a call that is meant to do that much work.

## Errors

Errors are typed (`XPathError` and its subclasses, each with a stable `code`). The package ships as ES modules and as
CommonJS, so a program that loads both has two copies of the classes and `instanceof` fails across them. Use
`isXPathError(value)`, which recognises an error from either copy (by a brand registered with `Symbol.for`), and the
`code` property, which is the same string in both.

## Running it

Node >= 22.18 (the TypeScript sources run directly, by type stripping; `npm run build` makes the plain JavaScript in
`dist/`, see [Build and compatibility](#build-and-compatibility)).

```sh
npm ci
npm run check            # tsc (TypeScript 7, every strict flag), oxlint (type-aware), oxfmt --check
npm run test:unit        # unit tests of the engine (node:test)
npm run build            # dist/: ES modules and CommonJS with declarations, same compiler and strict options
npm run test:harness     # the harness tests itself on candidates whose verdict is known
npm run test:differential        # the engine against upstream xpath (documents, scenarios, random expressions)
npm run test:differential:fork   # the bugsee/xpath fork against upstream (its expression fuzzer: test:fuzz-expr:fork)
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
| `test/hostile-strict-digests.ts` | records the Recommendation's answer, from plain DOM code, on the hostile cases where strict mode differs from upstream by design (`baselines/strict-digests.json`, used when `CANDIDATE_MODE=strict`) |
| `test/strict-axes-fuzz.ts <documents> <expressions> [seed] [dom]` | strict `following::`/`preceding::` fast paths against the strict slow path (`XPathProgram.forceSlowPath`), on random node-set contexts with positional predicates |
| `test/strict-oracle.ts [dom] <documents> <expressions> [seed] [ns]` | strict mode against an independent reference evaluator written from the Recommendation (the data model, the axes, node tests, positions, unions), on random documents and location paths; `STRICT_ORACLE_MODE=upstream` is the self-test |
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

- Design ideas (lazy sort flags, context-sensitivity analysis, reverse-axis storage, predicate merging) were studied in
  the XPath implementations of WebKit, Blink and Gecko; no code from those projects is included.
- W3C, *XML Path Language (XPath) Version 1.0*, W3C Recommendation, 16 November 1999:
  <https://www.w3.org/TR/1999/REC-xpath-19991116/>
- `xpath` 0.0.36, the oracle (dev dependency): <https://github.com/goto100/xpath>, MIT.
- The [bugsee/xpath](https://github.com/bugsee/xpath) fork, judged by this harness (dev dependency): MIT, same
  copyright holders.

Other dev dependencies keep their own licences: `@xmldom/xmldom`/`xmldom` (MIT), `jsdom` (MIT), `happy-dom` (MIT),
`linkedom` (ISC), `samlify` (MIT), `xml-crypto` (MIT), `@authenio/xml-encryption` (MIT), `node-forge` (BSD-3-Clause
or GPL-2.0, used here under BSD-3-Clause), TypeScript (Apache-2.0), oxlint and oxfmt (MIT).
