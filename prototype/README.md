# Prototype snapshot

This directory is an **archival snapshot** of the prototype of the engine's hot paths, kept as it was produced. It
was written and measured against a local scratch layout (a checkout of upstream `xpath`, the `bugsee/xpath` fork,
installed DOM packages and signed SAML fixtures, all at absolute paths on one machine). Its scripts and the paths in
them are therefore **not runnable from this repository as they are**.

What it contains:

- `src/`: a lexer, a parser to an immutable AST, a closure compiler and an interpreter, node-sets as sorted arrays
  with a one-pass document-order numbering, lazy axes, and `compat.ts`, an entry with upstream `xpath`'s API;
- `test/`, `bench/`, `test-types/`: the harness and benchmarks it was checked with. The runnable, candidate-agnostic
  descendants of these are `test/` and `bench/` at the root of this repository;
- `check.sh`, `run-all.sh`, `verify.sh`, `tsconfig*.json`, `oxlintrc.json`: how it was type-checked, linted and run.

It is excluded from the root type-check, lint and format checks (it has its own configs). The engine is meant to
grow from this prototype into `src/` at the root.
