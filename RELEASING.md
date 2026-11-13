# Releasing

A release is a tag pushed by a maintainer. Everything after the tag is the release workflow
(`.github/workflows/release.yml`); no one publishes from a working tree (`npm publish` there fails on purpose: the
`prepublishOnly` script refuses anything that is not the workflow).

## To release

1. On a branch, set `version` in `package.json` (`1.2.3`, or `1.2.3-rc.1` for a prerelease) and add a `## [1.2.3] - YYYY-MM-DD`
   section to `CHANGELOG.md` with the changes (move them from `## [Unreleased]`). `npm run release:check -- v1.2.3`
   checks the two against the tag you are about to push.
2. Merge that through a pull request, as every change.
3. Tag the merge commit and push the tag:

   ```sh
   git tag -s v1.2.3 -m "v1.2.3"
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

- **npm trusted publisher.** On npmjs.com, for the package `xpath-es`: Settings, Trusted Publisher, GitHub Actions, organisation
  `bugsee`, repository `xpath-es`, workflow `release.yml`, environment `npm-release`. No npm token is stored in GitHub.
  (npm may require the package to exist before a trusted publisher can be set; if so, the first version is published once
  by an owner by hand, from a tarball made by this workflow's `pack` job, and every later one through the workflow.)
- **GitHub environment `npm-release`.** Settings, Environments: required reviewers (a maintainer who is not the one who
  pushed the tag, if there is more than one), and deployment branches and tags limited to `v*` tags.
- **Tag ruleset.** Settings, Rules: a ruleset for tags matching `v*` that restricts who can create them and blocks
  updates and deletion, so that a published version's tag cannot be moved.
- **Private vulnerability reporting** on (it is what `SECURITY.md` points to).

## What the package contains

`npm pack` ships `dist/` (ES modules and CommonJS, with declarations and source maps), `LICENSE` and `README.md`, and nothing
else; `npm run test:dist` checks the list and the content (the exports map, the syntax level, the declarations).
