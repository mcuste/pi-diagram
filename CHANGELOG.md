# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One `diagram` tool that renders D2 source into the transcript as Unicode box drawing, plain
  7-bit ASCII, or the D2 source itself. Containers, sequence diagrams, SQL tables, class shapes,
  and state flows all render.
- A safe-subset check that refuses `@` imports, `icon`, `link`, `shape: image`, `|...|` block
  labels, and renderer configuration before D2 is started. A relative import reads a file off
  disk and draws its contents, so this closes a live file-read channel rather than a theoretical
  one. Refusals carry a code, a line, a column, and what to do instead.
- Isolated rendering: no shell, no model-written string in the argument list, a private temporary
  directory holding only the source, an environment of just `PATH`, a time limit, an output
  limit, and cancellation through the host's abort signal.
- Checks on renderer output before it is displayed: not blank, plain ASCII really is 7-bit,
  Unicode output contains box drawing, and nothing but newlines can control the terminal.
- A retry in plain ASCII when Unicode output fails, then an explanation. D2's text renderer is
  beta, and a diagram it cannot draw is never replaced with a different one.
- Explicit refusals for `save` and `language: "mermaid"`, which the schema accepts but this
  version does not implement.
- Project tooling: TypeScript build, Biome, Knip, publint, dependency audit, CI with a pinned D2,
  and the tag-triggered release workflow.
- Safety model at `docs/safety.md`.
- Oh My Pi marketplace catalog at `.omp-plugin/marketplace.json`.
