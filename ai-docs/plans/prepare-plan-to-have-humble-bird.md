# Plan: create-bodhi-js-style release process for llm-liberty

## Context

`llm-liberty` is at `0.0.1`, has never been released, has no git remote configured, and has no CI/release automation. `CLAUDE.md` claims "Changesets + GitHub Actions → npm" but only the local Changesets half exists; four pending minor-bump changesets sit unconsumed.

We want to mirror the proven release flow used in `create-bodhi-js`:

1. Local pre-checks (right branch, no uncommitted changes, all commits pushed).
2. Fetch the latest published version from npmjs and compute the next minor.
3. If the target tag already exists locally or remotely, prompt to delete + recreate it.
4. Push the tag; a `v*`-triggered GitHub Actions workflow handles `npm publish` and creates a GitHub Release.

Decisions confirmed with the user:

- **Package name**: rename to `@bodhiapp/llm-liberty` (scoped under existing `bodhiapp` npm org). The bin name stays `llm-liberty`.
- **Bump policy**: minor only (`x.y.z → x.(y+1).0`), pure regex, no semver lib.
- **Version source of truth**: the npm registry, exactly like `create-bodhi-js`. Changesets is kept only for authoring human-readable change entries → `CHANGELOG.md`; its version bump is overwritten by the script.
- **Tag-time gates**: build-only in the workflow (no lint/typecheck/test on tag push). Local pre-checks are the quality gate.
- **Scope of this plan**: release workflow only. No CI workflow, no PR-gating workflow.
- **Entry point**: a `justfile` (not Makefile, not pnpm script).
- **Strict local checks**: uncommitted changes are a hard fail (stricter than `create-bodhi-js`, which only warns).

## Reference: create-bodhi-js mechanics being copied

- `Makefile :: release` orchestrates 5 zero-dep Node scripts under `scripts/`, then runs `git tag` + `git push origin <tag>`.
- Scripts use only Node built-ins (`https`, `child_process.execSync`, `readline`). No `semver`, no `prompts`, no `inquirer`.
- `https.get('https://registry.npmjs.org/<encoded-name>/latest')` returns `{ version }`. 404 → `'0.0.0'` (so first release computes `0.1.0`). 10 s timeout.
- Tag detection: `git rev-parse "${tag}"` with stderr suppressed. Deletion: `git tag -d <tag>` then `git push --delete origin <tag>`. Recreation lives in the `Makefile`, not the delete script.
- Workflow on `push: tags: ['v*']`: extract version from `refs/tags/v…`, `npm version --no-git-tag-version <ver>`, build, `npm publish`, create GitHub release, then bump `package.json` to `<next>-dev` and push to `main`. **We are not copying the `-dev` post-bump cycle** — we skip it because the version source is npm, so `package.json` doesn't need to lead.

## Files to create

### `justfile` (new, repo root)

Single `release` recipe matching `create-bodhi-js`'s `Makefile` target sequence, adapted for `pnpm` and the strict checks:

```just
# Default lists recipes
default:
    @just --list

# Cut a release: pre-checks → npm-version bump → tag → push
release:
    @echo "Preparing to release @bodhiapp/llm-liberty..."
    node scripts/git-check-branch.mjs
    node scripts/git-check-clean.mjs
    node scripts/git-check-pushed.mjs
    #!/usr/bin/env bash
    set -euo pipefail
    CURRENT_VERSION=$(node scripts/get-npm-version.mjs @bodhiapp/llm-liberty)
    NEXT_VERSION=$(node scripts/increment-version.mjs "$CURRENT_VERSION")
    echo "Current version on npmjs: $CURRENT_VERSION"
    echo "Next version to release: $NEXT_VERSION"
    TAG_NAME="v$NEXT_VERSION"
    node scripts/delete-tag-if-exists.mjs "$TAG_NAME"
    echo "Creating tag $TAG_NAME..."
    git tag "$TAG_NAME"
    git push origin "$TAG_NAME"
    echo "Tag $TAG_NAME pushed. GitHub workflow will publish."
```

(Note: `just` runs each line separately by default. We use a shebang recipe block for the parts that share variables — `just`'s standard pattern.)

### `scripts/` (new directory, five `.mjs` files)

All scripts: pure Node ESM, zero dependencies, runnable as `node scripts/<file>.mjs`. Pattern matches `create-bodhi-js` exactly. `.mjs` extension keeps them distinct from the TypeScript source under `src/` and avoids any tsup interaction.

1. **`scripts/git-check-branch.mjs`**

   Soft branch check, copied from create-bodhi-js. `git branch --show-current`. If `main` → exit 0. Otherwise warn + prompt `Continue anyway? [y/N]` via `readline`. `y`/`yes` proceeds; anything else exits 1.

2. **`scripts/git-check-clean.mjs`** *(stricter than create-bodhi-js)*

   `git status --porcelain`. If output is non-empty → log the dirty paths to stderr, exit 1. **No prompt** — uncommitted changes are a hard fail per user request. This is the deviation from `create-bodhi-js/scripts/git-check-sync.js` lines 41–46 (which only warns).

3. **`scripts/git-check-pushed.mjs`**

   `git fetch origin <branch>` → `git log origin/<branch>..HEAD --oneline`. Non-empty → unpushed commits → log them and exit 1. Then `git log HEAD..origin/<branch> --oneline` → non-empty → unpulled commits, prompt `Continue anyway? [y/N]`. (Splitting `git-check-sync.js` into `clean` + `pushed` keeps each script's responsibility singular and lets us strict-fail only on the right axis.)

4. **`scripts/get-npm-version.mjs`**

   Verbatim port of `create-bodhi-js/scripts/get-npm-version.js`:
   - `https.get('https://registry.npmjs.org/' + encodeURIComponent(pkgName) + '/latest')` with `User-Agent: 'llm-liberty Release Script'` and 10 s `request.setTimeout`.
   - 404 → `'0.0.0'`, non-200 → log + `'0.0.0'`.
   - Validate `^\d+\.\d+\.\d+$` (rejects pre-release tags like `-dev` or `-beta`).
   - Writes the version to stdout (consumed by `$(...)` in the justfile).

5. **`scripts/increment-version.mjs`**

   Verbatim port. Regex `^(\d+)\.(\d+)\.(\d+)$`, returns `${major}.${minor + 1}.0`. Pure regex + string concat, no `semver` import.

6. **`scripts/delete-tag-if-exists.mjs`**

   Verbatim port. `git rev-parse <tag>` (stderr suppressed) for detection. If exists, prompt `Delete and recreate tag <tag>? [y/N]`; on yes, run `git tag -d <tag>` then `git push --delete origin <tag>` (each in `try/catch` so a missing local-or-remote half doesn't crash the script). Recreation is the justfile's job (next two commands after this script returns).

### `.github/workflows/publish.yml` (new)

Trigger on tag push, build with `pnpm`, publish, create GH release. No post-release `-dev` bump (we don't use that pattern).

```yaml
name: Publish to npm

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Extract version from tag
        id: version
        run: |
          TAG_VERSION="${GITHUB_REF#refs/tags/v}"
          echo "tag_version=$TAG_VERSION" >> "$GITHUB_OUTPUT"

      - name: Sync package.json version with tag
        run: pnpm version "${{ steps.version.outputs.tag_version }}" --no-git-tag-version --allow-same-version

      - run: pnpm install --frozen-lockfile

      - run: pnpm build

      - name: Publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: pnpm publish --access public --no-git-checks

      - name: Verify publish
        run: |
          sleep 10
          npm view @bodhiapp/llm-liberty@${{ steps.version.outputs.tag_version }} version

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: Release ${{ github.ref_name }}
          body: |
            Published [@bodhiapp/llm-liberty@${{ steps.version.outputs.tag_version }}](https://www.npmjs.com/package/@bodhiapp/llm-liberty/v/${{ steps.version.outputs.tag_version }}) to npm.
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Required repo secret: `NPM_TOKEN` (publish-scoped automation token from the `bodhiapp` npm org). `GITHUB_TOKEN` is provided by Actions.

## Files to modify

### `package.json`

- `name`: `llm-liberty` → `@bodhiapp/llm-liberty`.
- Add `publishConfig`: `{ "access": "public" }` (scoped packages default to restricted; publishing public requires this).
- Add `repository`, `homepage`, `bugs` once the GitHub remote is created (use `https://github.com/BodhiSearch/llm-liberty`).
- `scripts.release`: replace `pnpm build && changeset publish` with `just release` (or remove it if we want `just release` to be the only path — recommend keeping `release` script as a thin alias for muscle memory: `"release": "just release"`).
- Keep `changeset` script and `@changesets/cli` devDep — Changesets stays for authoring change entries.
- `bin` stays `{ "llm-liberty": "./dist/cli.js" }` — bin name does not need to match the scoped package name; users will get `llm-liberty` on `PATH` after `npm i -g @bodhiapp/llm-liberty`.
- `prepublishOnly: pnpm build` stays as a defensive belt.

### `.changeset/config.json`

- `access`: `restricted` → `public`. Required for publishing scoped packages publicly. (Even though we won't use `changeset publish`, keeping this consistent avoids future foot-guns.)

### `.changeset/*.md` (4 pending entries)

Each currently has `"llm-liberty": minor` in its frontmatter. Update each to `"@bodhiapp/llm-liberty": minor`. Files:
- `.changeset/anthropic-provider.md`
- `.changeset/envelope-shape-cleanup.md`
- `.changeset/github-copilot-provider.md`
- `.changeset/google-gemini-provider.md`

### `README.md` and `docs/*.md`

Replace any `npx llm-liberty@latest` invocation with `npx @bodhiapp/llm-liberty@latest`. Critical files:
- `README.md`
- `docs/index.md`
- per-provider docs under `docs/` that show `npx` examples

### `CLAUDE.md`

Update line 14 to reflect the actual setup post-change:
- Drop the "Changesets" half from the release-stack one-liner (or rephrase to "GitHub Actions on tag push → npm; Changesets used for change-entry authoring").
- Update the primary invocation to `npx @bodhiapp/llm-liberty@latest`.
- Update repo-layout block to mention `scripts/`, `justfile`, `.github/workflows/`.

### `docs/development.md`

Update the scripts table:
- Remove or rephrase the `pnpm release` row (no longer "build + publish").
- Add `just release` row pointing to a new `docs/release.md` runbook (see below).

### `docs/release.md` (new)

Short runbook documenting the release flow end-to-end:
- Pre-flight: ensure on `main`, clean tree, all commits pushed.
- Run `just release`. Confirm tag deletion if prompted.
- Watch `.github/workflows/publish.yml` run.
- Verify `npm view @bodhiapp/llm-liberty version`.

## Out-of-scope prerequisites the user must do

These are not tracked file edits — flag them in the implementation pass:

- Create the GitHub repo `BodhiSearch/llm-liberty` (currently `git remote -v` is empty).
- `git remote add origin git@github.com:BodhiSearch/llm-liberty.git` and `git push -u origin main`.
- Generate an `Automation`-type npm access token from the `bodhiapp` org and add it as repo secret `NPM_TOKEN`.
- Confirm the `bodhiapp` npm org exists and the publishing user is a member with publish rights to `@bodhiapp/*`.

## Critical files referenced

- Source patterns to mirror:
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/create-bodhi-js/Makefile`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/create-bodhi-js/scripts/{git-check-branch,git-check-sync,get-npm-version,increment-version,delete-tag-if-exists}.js`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/create-bodhi-js/.github/workflows/publish.yml`
- Files to modify in this repo:
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/package.json`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/.changeset/config.json`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/.changeset/{anthropic-provider,envelope-shape-cleanup,github-copilot-provider,google-gemini-provider}.md`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/README.md`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/CLAUDE.md`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/docs/development.md`
  - `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/llm-liberty/docs/index.md` (and per-provider docs as needed)
- Files to create:
  - `justfile`
  - `scripts/git-check-branch.mjs`
  - `scripts/git-check-clean.mjs`
  - `scripts/git-check-pushed.mjs`
  - `scripts/get-npm-version.mjs`
  - `scripts/increment-version.mjs`
  - `scripts/delete-tag-if-exists.mjs`
  - `.github/workflows/publish.yml`
  - `docs/release.md`

## Verification

1. **Dry-run pre-checks (no remote yet)** — once scripts exist:
   - `node scripts/git-check-branch.mjs` on `main` → prints `✓ On main branch`.
   - Make a stray edit → `node scripts/git-check-clean.mjs` exits 1 with the dirty path printed.
   - Revert. After remote is added: `node scripts/git-check-pushed.mjs` → prints `✓ Branch is up to date with origin/main`.
2. **npm version fetch** — `node scripts/get-npm-version.mjs @bodhiapp/llm-liberty` should print `0.0.0` (package not yet published). Then `node scripts/increment-version.mjs 0.0.0` → `0.1.0`.
3. **Tag-exists prompt** — `git tag v0.1.0`, then `node scripts/delete-tag-if-exists.mjs v0.1.0` → prompts; answer `n` → exits 1; answer `y` → deletes local (remote delete will warn-and-continue since it doesn't exist).
4. **End-to-end first release** — once GitHub repo + `NPM_TOKEN` are wired:
   - `just release` → tags `v0.1.0`, pushes.
   - Workflow runs: `pnpm build` → `pnpm publish --access public` → GH Release created.
   - `npm view @bodhiapp/llm-liberty version` returns `0.1.0`.
   - `npx @bodhiapp/llm-liberty@latest --help` prints CLI usage.
5. **Re-release dry test** — try `just release` a second time without committing anything new; the npm fetch returns `0.1.0`, increment yields `0.2.0`, tag is fresh, flow proceeds. (Or stop at the prompt to avoid an empty release.)
