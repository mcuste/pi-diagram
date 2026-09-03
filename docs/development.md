# Development and release

## Layout

The repository is a pnpm workspace. Each package under `packages/` has its own `package.json`,
`tsconfig.json`, and `test/` directory, and imports the others by package name. TypeScript project
references build them in dependency order and reject an import that skips a layer. All four are
published together under one version.

| Package | Depends on | Contents |
| --- | --- | --- |
| `packages/core` | | Shared contracts and parsers that every other package uses |
| `packages/d2` | core | The render pipeline: preflight, profiles, the D2 CLI run, rasterization |
| `packages/display` | core | Host TUI loading plus the Pi and Oh My Pi result renderers |
| `packages/plugin` | core, d2, display | The `@mcuste/pi-diagram` extension both hosts install |

Only `@mcuste/pi-diagram` is published. The other three are private: esbuild bundles them into
`packages/plugin/dist/extension.js`, which is the file both hosts load and the package's only
export. Third-party packages stay outside the bundle as normal dependencies.

| Path | Contents |
| --- | --- |
| `packages/core/src/diagnostics.ts` | The diagnostic vocabulary and `DiagramSourceError` |
| `packages/core/src/normalize.ts` | Source normalization and title parsing |
| `packages/core/src/artifacts.ts` | The temp store, workspace path safety, and atomic bundle writes |
| `packages/core/src/cache.ts` | The render cache: its key, and the bounded store on disk |
| `packages/core/src/svg.ts` | Structural SVG and stylesheet parsing before rasterizing or saving |
| `packages/core/src/png.ts` | The checks on PNG bytes before they are stored or displayed |
| `packages/core/src/terminal.ts` | Control-character parsing for text that reaches a terminal |
| `packages/core/src/process.ts` | Child process execution |
| `packages/d2/src/render.ts` | Unicode, SVG, and PNG generation, fallbacks, and transcript limits |
| `packages/d2/src/runner.ts` | D2 discovery, version check, and the isolated render |
| `packages/d2/src/preflight.ts` | The safe-subset lexer |
| `packages/d2/src/profiles.ts` | What each profile does to a picture: engine, theme, and spacing |
| `packages/d2/src/diagnostics.ts` | Parsing of D2's errors into the shared vocabulary |
| `packages/d2/src/fonts.ts` | Recovering the fonts D2 embeds in its SVG, and what they can draw |
| `packages/d2/src/raster.ts` | Drawing the SVG as a PNG with resvg, and the image cache |
| `packages/display/src/` | Shared terminal image support plus separate Pi and Oh My Pi renderers |
| `packages/plugin/src/index.ts` | Extension entry point, and the input to the bundle |
| `packages/plugin/src/tools.ts` | The `diagram` tool: schema, approval tier, result shape, and cached description |
| `packages/plugin/src/tool-description.md` | The editable description shown to the model with the tool |
| `packages/plugin/src/guidance.md` | The editable prompt injected before an agent starts |
| `packages/plugin/src/guidance.ts` | Loading the cached prompt and appending it to the host prompt |
| `packages/*/test/*.test.mjs` | Deterministic suites, run by `pnpm test` |
| `packages/plugin/test/*.e2e.mjs` | Scenarios against the real D2 CLI, run by `pnpm test:integration` |
| `test/fixtures/` | Diagram fixtures shared by every package, and unsafe source under `security/` |
| `scripts/bundle.mjs` | Builds the single-file extension with esbuild |
| `scripts/preview.mjs` | Draws one source under every profile, for comparing them by eye |

Each package exports its public API from `src/index.ts`, and `exports` in its `package.json` points
at the built `dist/index.js`. Tests import their own package through `dist/` and other packages by
name, so a test can reach internals of the package it belongs to and only the public API of the
rest. The bundle is tested separately: the extension's package test loads it and checks that it
imports nothing but its dependencies and Node built-ins.

Validation is written as parsing, not checking. Each step turns loose input into a type that
records what was proven about it: `parseDiagramRequest` produces a typed request,
`normalizeSource` produces `NormalizedD2Source` and `SourceHash`, `parseSafeSource` produces
`SafeD2Source`, and `parseRenderedSvg` produces `RenderedSvg`. D2 accepts nothing else. Source
cannot reach the renderer without first being parsed, because there is no type for unchecked
source. Version, terminal text, artifact paths, raster dimensions, and image bytes use the same
pattern.

The render cache keys on the source, the binary, the D2 version, and the exact arguments D2 was
given. The arguments carry the profile, so there is no policy version to keep by hand: change a
theme or a spacing number and the key changes with it. Entries hold what D2 wrote, and a hit is
parsed again, so nothing skips the checks in `parseRenderedText` and `parseRenderedSvg`. Every
cache operation is best-effort, and a corrupt entry is drawn again instead of being returned.
Rendering the same diagram twice costs 642ms then 60ms, and only the version probe still runs.

The drawn image is kept in the same store, keyed on the SVG it came from, the installed resvg
version, and the scale and bounds in `packages/d2/src/raster.ts`. It is held as base64 behind the sizes it was
drawn at, and a hit goes back through `parseRenderedPng`, so a corrupt entry is drawn again rather
than displayed. The parser checks the PNG signature, every chunk boundary and CRC, one IHDR, at
least one IDAT, and a final IEND. Nothing is stored when the resvg version cannot be read, because
an image could then outlive the renderer that drew it. Redrawing a large diagram from the store
costs 18ms instead of 83ms.

A profile reaches D2 as CLI flags, not as text added to the source: flags win over source config,
and the saved `.d2` stays the model's own source, put through `d2 fmt`. The text render gets no
theme or spacing, because D2 draws text in character cells.

ELK is the engine for every profile except `tree`, which uses dagre. That is a deliberate
exception to ADR-004: dagre draws a hierarchy the way one is normally drawn. The engines expose
different spacing options, so `LayoutPolicy` is a union and `packages/d2/src/runner.ts` maps each case to
its own flags. D2 ignores the other engine's flags, so they are not passed.

`--elk-algorithm mrtree` looks right for `tree` but is not usable: in d2 0.8.1 it places the nodes
and draws no edges. `radial` never returns, and D2's `--timeout` does not stop it; only the
process timeout in `packages/d2/src/runner.ts` does.

Images take the same shape. `parseEmbeddedFonts` produces fonts whose table directory was checked,
and `parseRenderedPng` produces bytes from a complete PNG of the size that was asked for. The
display layer parses those bytes again after reading the temp file. D2's own PNG export needs a
headless browser that Playwright downloads on first use, which ADR-011 rules out, so
`packages/d2/src/raster.ts` draws the SVG this tool already produced.

`renderDiagram` prepares Unicode, a validated SVG, and a raster PNG before it commits any workspace
file. The commit step only receives a complete prepared result. An optional SVG or PNG failure
leaves usable text intact and adds a note. An explicit SVG save still fails if no safe SVG can be
produced. An explicit PNG save writes no empty file when rasterization fails.

Pi replaces Unicode with a terminal-width PNG when its tool row expands. Oh My Pi keeps Unicode in
the chronological tool result and opens the latest PNG in a viewport-fitted fullscreen overlay.
Explicit image requests use a compact preview in either host.

The shared display layer turns a private temp-store path into a `file://` URL only when OSC 8 is
available. Pi links the image it draws. Oh My Pi links the prepared PNG below Unicode so it remains
available after the transcript settles.

`@earendil-works/pi-tui` has to be the host's copy. The host paints the components built here, and
the library keeps image placement state in module scope, so two copies mean an image can reserve
its rows and draw nothing. `tuiSpecifier` resolves the real host entry point first, so an
executable symlink still leads to the host package. The static bare fallback lets OMP remap the
legacy package name to its in-process compatibility module.

The async extension factory resolves the host's TUI before the session starts. Every call prepares
all three representations. Unsupported terminals keep Unicode and report the image limitation only
when the user invokes the image view.

In a terminal the model gets a summary line and the diagram travels in `details`. Print, RPC, and
JSON modes return Unicode in `content`. `renderCall` draws the waiting row from the arguments and
leaves the source out.

`packages/plugin/package.json` points both `pi.extensions` and `omp.extensions` at
`dist/extension.js`. The root `package.json` carries the same keys with the path
`packages/plugin/dist/extension.js`, for a host that installs the repository from git or a local
path. The root `prepare` script builds on every `pnpm install`, so such a checkout has its bundle
as soon as dependencies are installed. The bundle ships with a source map, so a stack trace names
the TypeScript source.

The tool description lives in `packages/plugin/src/tool-description.md`. `primeDiagramDescription` reads it once
before the tool is registered. It owns D2 syntax, limits, and profile and shape selection. The
injected prompt lives in `packages/plugin/src/guidance.md` and owns when to draw and how to shape the response.
`registerDiagramGuidance` reads it once before installing the `before_agent_start` hook. The build
copies both files into `dist` for direct package imports.

Pi hands the prompt over as one string and Oh My Pi as ordered blocks, so both shapes are handled,
and the hook replaces what it returns. A prompt that cannot be read is left alone rather than being
reduced to the block. The block is left out when the host reports that the `diagram` tool is not
active, and a prompt that already carries it is not given a second copy.

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

Disable discovered extensions so an installed copy of this package cannot conflict with the
working copy:

```bash
pnpm build
pi -ne -e ./packages/plugin/dist/extension.js
omp --no-extensions -e ./packages/plugin/dist/extension.js
```

Run `pnpm build` again after editing, because the hosts load the bundle.

Run a diagram. In Pi, press `Ctrl+O` to replace Unicode in the tool row. In OMP, verify chronological
Unicode, then open and close the latest diagram's fitted PNG overlay with `Ctrl+O`.

Or install the working copy:

```bash
pi install /absolute/path/to/pi-diagram
omp plugin link /absolute/path/to/pi-diagram
```

A test that displays an image sets the pi-tui capabilities with `withCapabilities` instead of
inheriting them. The terminal running the suite should not decide whether the test passes.

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

1. **verify** checks that the tag matches the version in `packages/plugin/package.json`, then runs
   `pnpm check`.
2. **publish** publishes `@mcuste/pi-diagram` to npm. The other workspace packages are private and
   travel inside its bundle. It runs in the `npm-publish` environment, so a protection rule there can
   require manual approval before anything is published.
3. **github-release** creates the GitHub release, using the matching `CHANGELOG.md` section as its
   notes.

To cut a release, run `pnpm release <version>` from a clean `main`. It refuses to start unless the
version is above the current one, the worktree is clean, `main` is checked out, the tag is free,
and `CHANGELOG.md` has entries under `## [Unreleased]`. It then:

1. Sets the version in the root `package.json` and in every `packages/*/package.json`, and retitles
   the `Unreleased` section to `## [<version>] - <date>`.
2. Runs `pnpm check`, restoring the manifests and the changelog and stopping if the gate fails.
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
