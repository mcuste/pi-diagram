# Development and release

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Extension entry point; both hosts load it directly |
| `src/tools.ts` | The public `diagram` tool: schema, approval tier, and execution |
| `test/*.test.mjs` | Deterministic suites, run by `pnpm test` |
| `docs/terminal_diagram_tool_proposal.md` | The design the implementation follows |

The renderer described in the proposal is not built yet. It arrives as the modules listed in
section 16.1 of that document (source normalization, safe-subset preflight, D2 process runner,
profiles, diagnostics, render selection, cache, artifact writing), with a real-D2 integration suite
in `test/*.e2e.mjs` and a `pnpm test:integration` script to run it separately from the deterministic
suite. The D2 CLI version this project supports is pinned at that point; nothing here spawns `d2`
today.

Pi loads TypeScript through [jiti](https://github.com/unjs/jiti) and Oh My Pi runs it natively, so
`package.json` points both `pi.extensions` and `omp.extensions` at `src/index.ts` and no build step
is needed to install from npm, git, or a local path. The `dist/` build exists as a type check and
for anyone importing the package directly.

`typebox` is a peer dependency. Both hosts bundle it, and a second copy would hand the host a schema
it does not recognise.

## Commands

```bash
pnpm check             # Everything below, in one gate; also run by CI
pnpm fix               # Apply safe Biome formatting, import, and lint fixes
pnpm quality           # Check formatting, imports, and lint rules
pnpm test              # Build, then run the deterministic suite
pnpm deadcode          # Find unused files, exports, and dependencies with Knip
pnpm package:check     # Build and validate the publishable package with publint
pnpm security          # Audit dependencies for high-severity advisories
pnpm release <version> # Prepare, gate, commit, and tag a release
```

## Testing against a real host

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

Or install the working copy:

```bash
pi install /absolute/path/to/pi-diagram
omp plugin link /absolute/path/to/pi-diagram
```

## Continuous integration

`.github/workflows/ci.yml` runs the full `pnpm check` gate on every push and pull request.

## Release

Releases are published by `.github/workflows/release.yml`, triggered by pushing a `v<version>` tag.
It runs as three jobs:

1. **verify** checks that the tag matches the version in `package.json`, then runs `pnpm check`.
2. **publish** publishes to npm. It runs in the `npm-publish` environment, so a protection rule there
   can require manual approval before anything is published.
3. **github-release** creates the GitHub release, using the matching `CHANGELOG.md` section as its
   notes.

To cut a release, run `pnpm release <version>` from a clean `main`. It refuses to start unless the
version is above the current one, the worktree is clean, `main` is checked out, the tag is free,
and `CHANGELOG.md` has entries under `## [Unreleased]`. It then:

1. Sets the version in `package.json` and retitles the `Unreleased` section to
   `## [<version>] - <date>`.
2. Runs `pnpm check`, restoring both files and stopping if the gate fails.
3. Commits `chore: release <version>` and creates the `v<version>` tag.

Pushing stays separate, because that is where the release becomes public:

```bash
git push && git push origin v<version>
```

Pass `--push` to have the script do both pushes. Before the tag lands, undo everything with
`git tag -d v<version> && git reset --hard HEAD~1`.

### npm authentication

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the job requests
an OIDC token from GitHub and exchanges it with npm for a short-lived credential. There is no
`NPM_TOKEN` secret to store or rotate, and npm attaches a provenance attestation automatically.

Two constraints shape the workflow:

- npm cannot create a package through trusted publishing, so the first version of a new package must
  be published manually with `npm login && pnpm publish --access public`. Configure the trusted
  publisher afterwards, on the package's npm settings page, pointing at this repository, the
  `release.yml` workflow, and the `npm-publish` environment.
- `actions/setup-node` before v7 wrote a placeholder auth token that made npm skip the OIDC exchange,
  so the workflow pins v7.

The publish job holds the OIDC token, so it is kept small: no dependency cache, and
`pnpm install --ignore-scripts` so no dependency lifecycle script runs beside the credential. The
test suite runs in the separate verify job, which has no token.

## Ecosystem listings

Publishing to npm is all either ecosystem needs:

- **Pi** lists any package carrying the `pi-package` keyword in its gallery at
  [pi.dev/packages](https://pi.dev/packages). There is no submission step.
- **Oh My Pi** installs npm packages directly with `omp plugin install`, and reads the catalog at
  `.omp-plugin/marketplace.json` in this repository for `/marketplace add mcuste/pi-diagram`. That
  catalog tracks the `main` branch; point its `ref` at a tag to pin marketplace users to releases.
