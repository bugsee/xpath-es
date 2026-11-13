# Security policy

`xpath-es` evaluates XPath expressions on documents that may be hostile, and it is meant to sit in the path that verifies
XML signatures, so a security report is welcome and taken seriously.

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting for this repository
(<https://github.com/bugsee/xpath-es/security/advisories/new>), and not in a public issue or pull request.

Useful in a report: the version or commit, the expression and a minimal document (or a generator for one), what you
expected and what happened (a wrong node-set, a crash, work or time that the limits did not stop), and how you found it.

What counts:

- a node-set, a value or an error that differs from the XPath 1.0 Recommendation (strict mode) or from `xpath` 0.0.36
  (upstream mode) in a way that could change a security decision, a signature-wrapping bypass above all;
- an expression or a document that makes an evaluation use much more time or memory than its budget and time limit
  allow, or that makes it ignore them;
- anything in the published package or in the release process that could let someone else's code run, or put someone
  else's code in a release.

## Supported versions

Until a 1.0 release, only the latest release is supported.

## Releases

Releases are built and published by the release workflow from a tag on `main`, with npm provenance, so that the package
on the registry can be traced to the commit it was built from. See `RELEASING.md`.
