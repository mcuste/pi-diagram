# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-21

### Fixed

- The terminal library is now loaded from the host, not from this package. Both sides have to be
  the same copy, because the library keeps image placement state in module scope. A local checkout
  used its own copy, so an inline image could reserve its rows and draw nothing.
- Inline images are bounded to 30 rows. Without a height the library reserves a square, about 40
  rows, drawn or not.

### Added

- The drawn image is cached beside what D2 wrote. The key is the SVG, the installed resvg
  version, and the scale and bounds the image was drawn to, so no picture survives an upgrade
  or a policy change. Drawing a large diagram again takes 18ms instead of 83ms.
- A saved `.d2` is formatted with `d2 fmt` before it is written. If D2 will not format it, the
  source is saved as the model wrote it.
- The row shown while a diagram renders names the title, the profile, and the save directory,
  instead of the D2 source.
- In a terminal the diagram is drawn by this extension, so the model reads one summary line
  instead of its own picture. Print, RPC, and JSON modes still get the text: there the result is
  all the user sees.
- The expanded result row adds the render mode, the profile, the D2 version, the file paths,
  diagnostics, and the D2 source.
- A render cache. The key is the source, the binary, the D2 version, and the arguments D2 was
  given, which carry the profile, so a theme or spacing change cannot serve an old picture. The
  store lives outside the repository, holds 64 MB for a week, and drops the least recently used
  entries first. Drawing the same diagram again takes 60ms instead of 642ms, and works in a later
  session. One call also validates its source once rather than once per representation.
- Three more profiles. `tree` draws a hierarchy with dagre, which fans children out under their
  parent. `c4` is architecture spacing under D2's C4 palette. `dependency` is the tightest
  spacing, for a graph with more nodes than usual, and raises the node budget to about 25.
- `explain`, the default profile, is now drawn by hand: an answer in a conversation is a rough
  model, and a crisp diagram claims more precision than it has. Every other profile stays crisp.
- `profile` now decides how a diagram looks: `explain` is compact, `architecture` leaves room
  between rows, `data` stays tight because tables are tall already, and `docs` uses a grey theme
  that prints in greyscale. Every profile also sets a dark theme, so a saved SVG adapts to dark
  mode. The policy reaches D2 as CLI flags, which win over anything the source sets, so the saved
  `.d2` stays the source the model wrote. Text output is unchanged: D2 draws it in character
  cells.
- `formats` produces `.d2`, `.svg`, or `.txt` files and returns their paths. They are written to a
  private per-process temporary directory, not the repository, because most diagrams explain
  something in passing and should leave nothing behind.
- `save: { dir }` copies those files into the repository. `dir` is required: no directory
  convention holds across repositories, so the destination is named rather than assumed. The
  approval tier is `write` only for this case, and the prompt lists the exact files.
- Artifact path safety: relative paths only, no `..`, and the resolved directory is checked with
  `realpath` before any directory is created, so a symlinked `docs` cannot redirect a write out of
  the workspace. File names are slugified and bounded, existing non-regular files are never
  overwritten, and each file is written through a temporary name and a rename. The temp store is
  capped so a long session cannot fill it.
- Saved SVG is checked first: `<script>`, `<foreignObject>`, `<image>`, `<iframe>`, `<use>`, and
  remote `href` values are refused.
- Inline images, chosen by what the terminal actually supports. `auto` shows the drawn diagram
  where an image protocol is available and box drawing everywhere else; text is always prepared as
  the fallback, because the decision only settles when the result reaches the screen. A terminal
  with no image protocol is never sent one, and no SVG is rendered for it. The PNG lives in the
  temp store and is read back at display time, so its bytes never enter the model's context.
- PNG is drawn locally from the SVG rather than by D2, which exports it through a headless browser
  it downloads on first use. Labels use the fonts D2 embedded in the SVG, so the picture matches
  the boxes D2 measured; characters those fonts do not cover fall back to the machine's fonts and
  say so, rather than coming out as empty boxes.
- `formats` accepts `png` for places where SVG support is weak.
- A diagram that produces files but cannot be drawn as text now shows its source and keeps the
  SVG, rather than failing the whole call because the beta text renderer choked.
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
- Project tooling: TypeScript build, Biome, Knip, publint, dependency audit, CI with a pinned D2,
  and the tag-triggered release workflow.
- Safety model at `docs/safety.md`, and the design proposal the implementation follows at
  `docs/terminal_diagram_tool_proposal.md`.
- Oh My Pi marketplace catalog at `.omp-plugin/marketplace.json`.
