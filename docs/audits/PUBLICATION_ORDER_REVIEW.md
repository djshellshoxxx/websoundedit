# Publication-order correction

## Finding

The main workflow originally created the immutable `v1.0.0-beta.1` prerelease before publishing and verifying the required GitHub wiki. A later wiki failure could leave an incomplete acceptance result with the tag already fixed to that commit. `scripts/publish-release.mjs` correctly refuses to move an existing tag to a corrective commit; the workflow therefore needs to satisfy the wiki prerequisite first.

## Minimal correction

Only the two publication steps were reordered in `.github/workflows/pages.yml`. The order is now:

1. Run the complete verification action and deploy Pages.
2. Verify the published page and perform the real browser edit.
3. Prepare the web/companion archives, release notes and checksums.
4. Publish the wiki and verify its remote commit, exact public raw sources and rendered page identity/content.
5. Create or verify the immutable prerelease and collect its release metadata.
6. Upload publication evidence with the existing `if: always()` condition.

The wiki and prerelease steps retain ordinary success gating. Any wiki exception or verification failure therefore prevents the release script from running. No permissions, credentials, branch guards, release/tag checks, wiki validation, artifact paths or deployment checks were relaxed. Packaging still creates `artifacts/` before either publication step writes its evidence.

## Static verification and limits

Parsed the before/after workflow and verified that its only structural change is swapping the wiki and prerelease steps. Confirmed the main-only/non-pull-request publication condition, unchanged permissions and all other step definitions, ordering of smoke/packaging/wiki/release/evidence, default success gating, absence of `continue-on-error`, and retained always-upload evidence. `git diff --check` passed. No broad runtime suite or external publication was run for this ordering-only correction.

An anonymous wiki URL read by the coordinator redirected to the repository; it is not evidence of an authorized Git clone failure or a confirmed permission problem. The guarded publisher will report an actual unavailable/uninitialized wiki precisely if the authorized main run encounters one. This correction does not initialize a wiki or change repository settings.

Pages can already be live if the later wiki step fails. The overall publication job then remains failed and the immutable beta release remains uncreated; the workflow does not roll back the verified Pages deployment or claim that all publication requirements succeeded.
