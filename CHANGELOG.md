# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first release.

## [Unreleased]

## [1.0.0-rc.0] - 2026-11-13

The first release, a release candidate: it is published under the npm dist-tag `next` (`npm install xpath-es@next`). It is
published by hand from the release workflow's tarball (without a provenance statement), which creates the package on npm so
that trusted publishing can be set up; later releases go through the workflow, with provenance (see `RELEASING.md`).

### Added

- An XPath 1.0 engine in strict TypeScript (ES2022, ES modules and CommonJS, declarations, no runtime dependencies):
  lexer, parser to an immutable AST, closure compiler, document-order numbering, lazy axes.
- Strict mode (the default), which follows the XPath 1.0 Recommendation, and `upstream` mode, which reproduces the answers
  of `xpath` 0.0.36 for existing consumers (SAML and XML-signature libraries). The deviations from the Recommendation and
  from upstream are listed in the README.
- A work budget and a wall-clock limit on every evaluation, with typed errors (`XPathError` and its subclasses), for
  documents and expressions that an attacker controls.
- A compatibility entry with the API of `xpath` (`select`, `select1`, `parse`, `evaluate`, `useNamespaces`, the value
  classes, the `is*` guards), typed against the DOM library where the consumer has it.
- Linear strict `following::` and `preceding::` over node-sets, and cached evaluation of absolute paths in predicates.
- A differential harness against upstream `xpath`, a hostile-document suite, an independent strict reference evaluator,
  mutation testing of the checks themselves, and browser smoke tests (Chromium, Firefox, WebKit).
- The release workflow, `SECURITY.md` and `RELEASING.md`.

### Not yet

- Not adopted by any consumer in production. It needs checks against real identity-provider responses first.
