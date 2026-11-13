# Releasing

A release is a tag pushed by a maintainer. Everything after the tag is the release workflow
(`.github/workflows/release.yml`); no one publishes from a working tree (`npm publish` there fails on purpose: the
`prepublishOnly` script refuses anything that is not the workflow).

## To release

1. On a branch, set `version` in `package.json` and add a section with the same version to `CHANGELOG.md`, with the changes
   (move them from `## [Unreleased]`). For a release: version `1.2.3`, heading `## [1.2.3] - YYYY-MM-DD`, tag `v1.2.3`. For a
   prerelease: version `1.2.3-rc.1`, heading `## [1.2.3-rc.1] - YYYY-MM-DD`, tag `v1.2.3-rc.1`.
   `npm run release:check -- v1.2.3` (or the prerelease tag) checks the three against each other.
2. Merge that through a pull request, as every change.
3. Tag the merge commit and push the tag:

   ```sh
   git tag -s v1.2.3 -m "v1.2.3"       # v1.2.3-rc.1 for a prerelease
   git push origin v1.2.3
   ```

4. The workflow runs: it checks that the commit is on `main` and that the tag, `package.json` and the changelog agree, runs the
   whole CI on the commit, builds one tarball with its SHA-256, and waits for approval of the `npm-release` environment.
   Review the run (the tarball's file list is in the `pack` job's log), then approve it.
5. It publishes that tarball with provenance, then creates the GitHub release with the tarball, the checksum and the
   changelog section. A prerelease goes to the npm dist-tag `next` and is marked as a prerelease; only a release without
   a prerelease part becomes `latest`.

A failed run before `publish` publishes nothing: fix the cause and push a new tag (do not move a tag that has been pushed). A
version that has been published cannot be published again; to withdraw a bad release use `npm deprecate`, and release the next
version.

## One-time setup (a repository and npm owner)

- **npm trusted publisher.** On npmjs.com, in the settings of the package `xpath-es` (so the package has to exist: see the
  first release below): Trusted Publisher, GitHub Actions, organisation `bugsee`, repository `xpath-es`, workflow
  `release.yml`, environment `npm-release`. Under the allowed actions, tick **publish directly with `npm publish`**: this
  workflow publishes directly, and a configuration made without it only permits `npm stage publish`, so the publish job
  would be refused. (`npm dist-tag` is not needed.) No npm token is stored in GitHub. Trusted publishing needs npm 11.5.1 and
  Node 22.14 or newer, which the workflow has. npm asks a new configuration to complete its first successful publish
  within two days.
- **GitHub environment `npm-release`.** Settings, Environments: required reviewers (a maintainer who is not the one who
  pushed the tag, if there is more than one), and deployment branches and tags limited to `v*` tags.
- **Tag ruleset.** Settings, Rules: a ruleset for tags matching `v*` that restricts who can create them and blocks
  updates and deletion, so that a published version's tag cannot be moved.
- **Private vulnerability reporting** on (it is what `SECURITY.md` points to).

## The first release (bootstrapping npm), done

npm's documentation sets a trusted publisher up from the settings of an existing package, so the very first version could not go
through the workflow. `1.0.0-rc.0` was published by hand, once, from the tarball of the workflow's `pack` job (checked against
its `SHA256SUMS`), with `npm publish <tarball> --access public --tag next`, which made the package and had no provenance
statement. The trusted publisher was configured after that, and `1.0.0-rc.1` was the first release through the workflow. The
approval of `npm-release` in the run of `v1.0.0-rc.0` was left to fail (the publish job had no package to publish to); nothing
of that kind is needed again: every release is the steps above.

The trusted publisher's values are: organisation `bugsee`, repository `xpath-es`, workflow `release.yml`, environment
`npm-release`, and direct `npm publish` allowed.

## What the package contains

`npm pack` ships `dist/` (ES modules and CommonJS, with declarations and source maps), `LICENSE` and `README.md`, and nothing
else; `npm run test:dist` checks the list and the content (the exports map, the syntax level, the declarations).
