# Releasing

## Prerequisites

- On the `main` branch with a clean working tree.
- All commits pushed to `origin/main`.
- `just` installed (`brew install just`).
- The `BodhiSearch/llm-liberty` GitHub repo must exist with an `NPM_TOKEN` secret set (publish-scoped automation token from the `bodhiapp` npm org).

## Cut a release

```bash
just release
```

What it does:

1. **Branch check** — warns if you're not on `main`; prompts to continue.
2. **Clean check** — hard-fails if there are uncommitted changes.
3. **Pushed check** — fetches `origin/main`; hard-fails if you have unpushed commits; prompts if there are unpulled commits.
4. **Fetch npm version** — queries `registry.npmjs.org/@bodhiapp/llm-liberty/latest`; returns `0.0.0` if the package hasn't been published yet.
5. **Bump minor** — computes `x.(y+1).0`.
6. **Tag exists?** — if the computed tag (e.g. `v0.1.0`) already exists locally or remotely, prompts `Delete and recreate? [y/N]` and deletes both copies.
7. **Tag + push** — `git tag v<next>` then `git push origin v<next>`.

## After the tag is pushed

The `.github/workflows/publish.yml` workflow runs automatically:

1. Syncs `package.json` version to match the tag (no commit — just for the publish artifact).
2. `pnpm install --frozen-lockfile`
3. `pnpm build`
4. `pnpm publish --access public`
5. Verifies the published version with `npm view`.
6. Creates a GitHub Release for the tag.

## Verify

```bash
npm view @bodhiapp/llm-liberty version
npx @bodhiapp/llm-liberty@latest --help
```

## Authoring change entries

Before or during your PR, run:

```bash
pnpm changeset
```

Select the bump kind (`minor` for new features, `patch` for bugfixes) and write a short description. The generated `.changeset/<slug>.md` file gets committed with your PR and accumulates until `pnpm changeset version` is run to produce `CHANGELOG.md`.

The release script itself does not invoke `changeset version` — the version comes from the npm registry. Run `pnpm changeset version` manually when you want to regenerate `CHANGELOG.md` from pending entries.
