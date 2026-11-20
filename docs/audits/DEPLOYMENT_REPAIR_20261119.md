# Deployment and prerelease repair — 19 November 2026

## Observed failure

GitHub Actions [run 44553691921](https://github.com/djshellshoxxx/websoundedit/actions/runs/44553691921), for source `83c1dcfb1a78b7d9a8448f4f08a8aa4bdc766166`, completed the verification action, Pages deployment, live application verification and archive preparation. Job `135663891336` then failed at **Publish and verify the GitHub wiki** with `WIKI_UNAVAILABLE` because the wiki repository could not be cloned. The prerelease step was skipped.

This was a wiki publication failure after a successful Pages deployment. GitHub's [wiki documentation](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages) requires the initial page to be created on GitHub before a wiki can be cloned. An unavailable wiki also requires checking its existing token access. Neither initialization nor access is established by the local regression tests.

## Corrections

- **Separate deployment and release results.** `Verify and deploy Pages` runs the complete verification action, deploys, checks the live app, and preserves deployment evidence. The dependent `Publish wiki and prerelease` job restores that run's exact Pages artifact. It packages only a build whose version and commit match the clean source checkout. Wiki publication and public verification remain mandatory before prerelease creation. No failed gate is ignored.
- **Versioned packaging.** Archive names, release notes, title, metadata and tag come from the validated semantic prerelease version in `package.json`. The previous hardcoded beta.1 publisher was reproduced rejecting beta.2 before transport. Changing the package version now selects the matching `docs/releases/<version>.md` and assets; an existing tag on a different source commit still fails.
- **Verified and retryable uploads.** Before transport, the publisher validates local archive checksums, source/build identity and release notes. It verifies the remote tag and GitHub's uploaded asset sizes and SHA-256 digests after publication and on retries. A retry can upload absent assets when the tag and every existing expected asset match; it never overwrites an asset or moves a tag. Unexpected HTTP errors are fatal.
- **Reproducible artifacts.** `build.json` identifies the source version, commit and source commit date. It no longer embeds the current wall-clock time. ZIP entries are sorted and use the source commit timestamp and fixed file permissions, so restarting the same verified build does not generate a different package solely because of timestamps. Source archives still use `git archive` for the exact commit.
- **Useful failure evidence.** The wiki and release CLI entry points retain structured failure JSON while exiting nonzero. Credentials and raw subprocess output are excluded from their error evidence.
- **Browser installation.** CI installs Chromium, Firefox and WebKit before running the configured desktop and mobile projects. Browser execution results belong to the exact resulting CI run, not to this local script review.

The deployment job now requires read-only repository contents plus Pages/OIDC permissions. Repository contents write access is confined to the dependent wiki/release job. The wiki's existing fixed destination, public content verification and no-force-push protections remain unchanged.

## Executed local verification

`node --test tests/publish-release.test.js tests/publish-wiki.test.js` passed **25 tests, zero failures or skips**. Coverage includes real temporary Git repositories, actual ZIP and source archive creation, package retry byte equality after file timestamp changes, version advancement, mismatched source/build/tag rejection, partial upload recovery, tampered remote metadata rejection, source checksum rejection, and structured wiki failure evidence. Remote GitHub publication in these tests is simulated.

`npm run build` passed production compilation and the DOM-free SDK check, including a real PCM edit, WAV round trip and interpreted typed macro. YAML parsing confirmed the dependent release job, unchanged wiki-before-prerelease gating, separate permissions, and installation of all three browser engines. `git diff --check` passed.

## Remaining remote work

The missing/unavailable wiki must still become readable and writable through the existing authorized account before a full prerelease can succeed. A successful local package test does not establish wiki availability, a remote deployment, a browser matrix pass, or an uploaded release. Pages can succeed independently, and the release job will preserve the precise wiki blocker until it is resolved.

The two guide/wiki branches were compared with current `main`; their older publication code and guide work are already represented by the more complete current implementation. Reintroducing their snapshots would remove later verification and documentation improvements.

## Upstream references

- [GitHub release asset metadata and SHA-256 digests](https://docs.github.com/en/rest/releases/assets)
- [Official Pages artifact action and archive format](https://github.com/actions/upload-pages-artifact)
- [Official Pages artifact download/extraction example](https://github.com/actions/upload-pages-artifact/blob/main/.github/workflows/test-hosted-runners.yml)
