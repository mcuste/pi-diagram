# Development and release

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Extension entry point; both hosts load it directly |
| `src/tools.ts` | The `diagram` tool: schema, approval tier, and result shape |
| `src/render.ts` | Representation choice, the text fallback ladder, and transcript limits |
| `src/raster.ts` | Drawing the SVG as a PNG, and the checks on what comes back |
| `src/display.ts` | Building the terminal components, including the inline image |
| `src/d2/fonts.ts` | Recovering the fonts D2 embeds in its SVG, and what they can draw |
| `src/normalize.ts` | Source normalization and title parsing |
| `src/artifacts.ts` | The temp store, workspace path safety, and atomic writes |
| `src/d2/preflight.ts` | The safe-subset scanner |
| `src/d2/profiles.ts` | What each profile does to a picture: engine, theme, and spacing |
| `src/d2/runner.ts` | D2 discovery, version check, and the isolated render |
| `src/d2/diagnostics.ts` | The diagnostic vocabulary and parsing of D2's errors |
| `src/process.ts` | Child process execution |
| `scripts/preview.mjs` | Draws one source under every profile, for comparing them by eye |
| `test/*.test.mjs` | Deterministic suites, run by `pnpm test` |
| `test/*.e2e.mjs` | Scenarios against the real D2 CLI, run by `pnpm test:integration` |
| `test/fixtures/` | Diagram fixtures, and unsafe source under `security/` |
| `docs/terminal_diagram_tool_proposal.md` | The design the implementation follows |

Validation is written as parsing, not checking. Each step turns loose input into a type that
records what was proven about it: `normalizeSource` produces `NormalizedD2Source`,
`parseSafeSource` produces `SafeD2Source`, and `D2Cli.renderText` accepts nothing else. Source
cannot reach the renderer without having been checked, because there is no type for it to arrive
as. `parseD2Version`, `parseRenderedText`, and `parseBinaryName` work the same way.

Still to build: the render cache and the Mermaid adapter.

A profile reaches D2 as CLI flags, not as text added to the source: flags win over source config,
and the saved `.d2` has to stay the source the model wrote. The text render gets no theme or
spacing, because D2 draws text in character cells.

ELK is the engine for every profile except `tree`, which uses dagre. That is a deliberate
exception to ADR-004: dagre draws a hierarchy the way one is normally drawn. The engines expose
different spacing options, so `LayoutPolicy` is a union and `src/d2/runner.ts` maps each case to
its own flags. D2 ignores the other engine's flags, so they are not passed.

`--elk-algorithm mrtree` looks right for `tree` but is not usable: in d2 0.8.1 it places the nodes
and draws no edges. `radial` never returns, and D2's `--timeout` does not stop it; only the
process timeout in `src/d2/runner.ts` does.

Images take the same shape. `parseEmbeddedFonts` produces fonts whose table directory was checked,
and `parseRenderedPng` produces bytes that really are a PNG of the size that was asked for; the
display layer accepts nothing else. D2's own PNG export needs a headless browser that Playwright
downloads on first use, which ADR-011 rules out, so `src/raster.ts` draws the SVG this tool
already produced.

`@earendil-works/pi-tui` has to be the host's copy. The host paints the components built here, and
the library keeps image placement state in module scope, so two copies mean an image can reserve
its rows and draw nothing. `tuiSpecifier` resolves it from the host entry point and falls back to a
bare import; a local checkout would otherwise use its own copy, at its own version.

Whether a terminal can show an image is known when the result is displayed, not when it is
rendered, so both representations are always prepared. `renderResult` picks one. Throwing from
there is how the host is told to render its own text, which is why the text path needs no
duplicate in this package.

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
pnpm test:integration  # Build, then run the scenarios against the real D2 CLI
pnpm preview           # Draw one source under every profile into /tmp/diagram-preview
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

The two suites are separated by filename, not by an environment variable, so neither can be
skipped without the skip being visible in the run. The integration suite asserts structure rather
than exact drawings: D2's text renderer is beta and its output shifts between releases, so golden
art would break on every upgrade without telling us anything.

## The D2 dependency

The supported floor is D2 0.8.0. 0.7.x accepts the same flags but draws `shape: sql_table` as an
empty box, losing every column, and database diagrams are a core use case.

The prebuilt GitHub release binaries stop at v0.7.1, so they are below the floor. Install with
`brew install d2`, which ships 0.8.1, or from the pinned module version:

```bash
go install github.com/d2lang/d2@v0.8.1
```

The module path changed at 0.8: it is `github.com/d2lang/d2`, not `oss.terrastruct.com/d2`.

## Continuous integration

`.github/workflows/ci.yml` runs the full `pnpm check` gate on every push and pull request, with
D2 installed from the pinned module version. The Go checksum database verifies what is fetched.

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
