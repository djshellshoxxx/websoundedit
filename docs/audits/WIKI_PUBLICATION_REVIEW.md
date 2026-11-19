# Wiki public-content verification review

## Finding and correction

Independent review found that the candidate publisher checked public wiki responses for HTTP 200, an HTML content type and an HTML document marker, but did not establish that the HTML represented the intended wiki page. A generic sign-in or error page could therefore satisfy that portion of verification even when exact raw Markdown bytes were available separately. The finding concerns publication evidence; it does not allow a page to execute a macro or acquire a device.

`scripts/publish-wiki.mjs` now requires the document title to identify the expected page and `djshellshoxxx/websoundedit Wiki`, and an actual H1 to match the source page's first-level heading. Comparison normalizes ordinary HTML entities and whitespace. Comment, script, style and template content cannot supply the required heading. Ordinary source pages must contain a plain H1 before any clone or push; `_Sidebar` and `_Footer` remain fragments. Exact anonymous raw-byte verification, response bounds, redirect rejection and the fixed repository destination remain enforced.

Public GitHub wiki titles were inspected on the OBS Studio Home and Advanced Recording Guide pages on 19 November 2026. Titles use the page filename with hyphens rendered as spaces, followed by the repository identity and GitHub suffix. This observation supports the current title rule, not a guarantee that GitHub's HTML will never change. A future incompatible HTML change fails publication visibly.

## Executed verification

`node --test tests/publish-wiki.test.js` passed **12 tests, zero failures or skips**. An independent reviewer reran the same 12 tests and approved the correction. The suite executes local Git clone/commit/push verification against a temporary repository and simulated bounded public responses. New cases reject generic sign-in HTML, the wrong repository or page, a missing heading, headings concealed in comments/scripts, and escaped markup. Valid entity-normalized headings pass; missing or formatted source H1 values fail before publication.

The focused coordinator log is `test-results/audits/publish-wiki-visibility-unit.log`. These local tests do not establish real GitHub wiki availability or token access. A bounded anonymous read of the repository's `/wiki` URL returned HTTP 200 after redirecting to the main repository page; it did not render the wiki. This is recorded as evidence that initialization may be absent, not as a completed authorized Git publication attempt. The main workflow must establish the actual remote result.

## Remaining remote gate

The publisher uses only the workflow's existing repository-scoped token. It does not create credentials, change repository permissions, force-push, replace unrelated wiki pages or bypass a missing initial wiki page. A clone, push, remote-ref, raw-byte or public-HTML failure remains fatal and must be reported precisely. The [publication-order correction](PUBLICATION_ORDER_REVIEW.md) places this gate before immutable beta release creation.
