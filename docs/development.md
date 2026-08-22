# Development and release

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Extension entry point; both hosts load it directly |
| `src/tools.ts` | The `diagram` tool: schema, approval tier, result shape, and cached description |
| `src/tool-description.md` | The editable description shown to the model with the tool |
| `src/guidance.md` | The editable prompt injected before an agent starts |
| `src/guidance.ts` | Loading the cached prompt and appending it to the host prompt |
| `src/render.ts` | Representation choice, Unicode fallback, and transcript limits |
| `src/config.ts` | Persistent render preference paths and precedence |
| `src/raster.ts` | Drawing the SVG as a PNG, and the checks on what comes back |
| `src/display.ts` | Building the terminal components, including the inline image |
| `src/terminal.ts` | Control-character parsing for text that reaches a terminal |
| `src/svg.ts` | Structural SVG and stylesheet parsing before rasterizing or saving |
| `src/d2/fonts.ts` | Recovering the fonts D2 embeds in its SVG, and what they can draw |
| `src/normalize.ts` | Source normalization and title parsing |
| `src/artifacts.ts` | The temp store, workspace path safety, and atomic bundle writes |
| `src/cache.ts` | The render cache: its key, and the bounded store on disk |
| `src/d2/preflight.ts` | The safe-subset lexer |
| `src/d2/profiles.ts` | What each profile does to a picture: engine, theme, and spacing |
| `src/d2/runner.ts` | D2 discovery, version check, and the isolated render |
| `src/d2/diagnostics.ts` | The diagnostic vocabulary and parsing of D2's errors |
| `src/process.ts` | Child process execution |
| `scripts/preview.mjs` | Draws one source under every profile, for comparing them by eye |
| `test/*.test.mjs` | Deterministic suites, run by `pnpm test` |
| `test/*.e2e.mjs` | Scenarios against the real D2 CLI, run by `pnpm test:integration` |
| `test/fixtures/` | Diagram fixtures, and unsafe source under `security/` |

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
version, and the scale and bounds in `src/raster.ts`. It is held as base64 behind the sizes it was
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
different spacing options, so `LayoutPolicy` is a union and `src/d2/runner.ts` maps each case to
its own flags. D2 ignores the other engine's flags, so they are not passed.

`--elk-algorithm mrtree` looks right for `tree` but is not usable: in d2 0.8.1 it places the nodes
and draws no edges. `radial` never returns, and D2's `--timeout` does not stop it; only the
process timeout in `src/d2/runner.ts` does.

Images take the same shape. `parseEmbeddedFonts` produces fonts whose table directory was checked,
and `parseRenderedPng` produces bytes from a complete PNG of the size that was asked for. The
display layer parses those bytes again after reading the temp file. D2's own PNG export needs a
headless browser that Playwright downloads on first use, which ADR-011 rules out, so
`src/raster.ts` draws the SVG this tool already produced.

`renderDiagram` prepares every render, fallback, measurement, and artifact payload before it
commits any workspace file. The commit step only receives a complete prepared result. An optional
inline-image SVG failure leaves usable text intact. Explicit SVG and PNG artifact requests still
fail rather than writing a partial representation.

The collapsed result uses a 60 by 18 cell preview. The host's expanded state is the zoom control:
`renderResult` removes the preview width cap and permits up to 60 rows. The TUI still limits the
image to the current render width, so it cannot overflow horizontally.

The diagram is also a link. `openable` in `src/display.ts` turns the path in the temp store into
a `file://` URL, and the title, or the file name when there is no title, carries it. The link is
emitted only when the terminal reports OSC 8 support and only when the image is really drawn,
because a link to a picture the row does not show would be misleading. Nothing in either host is
needed for the click: the terminal itself opens the file.

`@earendil-works/pi-tui` has to be the host's copy. The host paints the components built here, and
the library keeps image placement state in module scope, so two copies mean an image can reserve
its rows and draw nothing. `tuiSpecifier` resolves the real host entry point first, so an
executable symlink still leads to the host package. The static bare fallback lets OMP remap the
legacy package name to its in-process compatibility module.

The async extension factory resolves the host's `pi-tui` copy and detects image support before the
host starts its session. A tool call therefore cannot race this initialization. Whether a result
row actually draws an image is still settled when it is displayed, so both representations are
prepared. `renderResult` throws only when the terminal library is missing, which tells the host to
print the content instead.

So in a terminal the model gets a summary line and the diagram travels in `details`. Nothing calls
`renderResult` in print, RPC, and JSON modes, so there `content` still carries the text.
`renderCall` draws the waiting row from the arguments, and leaves the source out of it.

Pi loads TypeScript through [jiti](https://github.com/unjs/jiti) and Oh My Pi runs it natively, so
`package.json` points both `pi.extensions` and `omp.extensions` at `src/index.ts` and no build step
is needed to install from npm, git, or a local path. The `dist/` build exists as a type check and
for anyone importing the package directly.

The tool description lives in `src/tool-description.md`. `primeDiagramDescription` reads it once
before the tool is registered. It owns D2 syntax, limits, and profile and shape selection. The
injected prompt lives in `src/guidance.md` and owns when to draw and how to shape the response.
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

The default is Unicode. Disable discovered extensions so an installed copy of this package cannot
conflict with the working copy:

```bash
pi -ne -e ./src/index.ts
omp --no-extensions -e ./src/index.ts
```

Add `--diagram-render image` to test the image path.

Or install the working copy:

```bash
pi install /absolute/path/to/pi-diagram
omp plugin link /absolute/path/to/pi-diagram
```

A test that needs an image sets the pi-tui capabilities with `withCapabilities` instead of
inheriting them. The terminal that runs the suite decides whether an image is produced at all, so
an inherited capability passes on a developer machine and fails on a CI runner, which has no
terminal.

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
