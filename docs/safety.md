# Safety model

Diagram source is written by a language model and often quotes repository text, so it is treated
as untrusted input. Two things protect the machine it runs on: a check of the source before D2
starts, and the way D2 is started.

## Why the source is checked at all

D2 is a full language with file and asset access. This is a real diagram that reads a file:

```d2
a -> b
...@secret/private
```

Given that source, D2 reads `secret/private.d2` from disk and draws its contents as part of the
diagram. Absolute paths work too, so running D2 in a private directory does not stop it. `icon`
accepts local paths and remote URLs, and `shape: image` loads whatever it is pointed at. A
diagram tool without a source check is a file-read and network-fetch tool.

## What the source check allows

| Feature | Policy |
| --- | --- |
| Nodes, edges, labels, containers | Allowed |
| Sequence diagrams, SQL tables, class shapes | Allowed |
| Built-in shapes | Allowed from a fixed list |
| `@` imports, including `...@` spreads | Refused |
| `icon:` | Refused |
| `link:` | Refused |
| `shape: image` | Refused |
| `\|...\|` block strings: Markdown, LaTeX, code | Refused |
| `d2-config`, `layout-engine` | Refused |

Refusals report a code, a line, a column, and what to do instead, so the model can correct the
source in one more call rather than guessing.

The check reads the source with a small scanner that understands comments and quoted strings
before looking for anything else. That matters in both directions:

- `a: "user@example.com"` and `# icon: https://example.com/x.svg` are ordinary text and are
  allowed. So is `a: user@example.com`, because D2 only treats `@` as an import at the start of a
  token.
- An unterminated quote, or a block string, means the scanner can no longer tell code from
  content. Both are refused rather than guessed at. D2 rejects unterminated quotes as well, so
  nothing valid is lost.

## How D2 is started

| Control | What happens |
| --- | --- |
| No shell | `execFile` with an argument array. No command string is ever built. |
| No model input in the argument list | The arguments are fixed literals. Source travels only as a file. |
| Private working directory | A fresh temporary directory holding one file, `input.d2`, removed when the call ends. |
| Minimal environment | Only `PATH`, so a bare command name can be found. Nothing else is passed on. |
| Time limit | `--timeout 10` for D2, and a process limit above it in case D2 itself hangs. |
| Output limit | The render is stopped past 512 KB, and a drawing too large for a transcript is refused. |
| Cancellation | The host's abort signal terminates the subprocess. |
| Version check | Below the supported version, the call reports how to install a supported one. No renderer is ever downloaded during a call. |
| Fixed layout | ELK, chosen here rather than in the source. |
| No path leak | D2 puts absolute paths in its render errors. They are stripped before anything is returned. |

## What is checked after D2 runs

D2 exiting zero is not taken as proof the output is usable. Before anything is displayed:

- The drawing is not blank. D2's text renderer can return an empty box instead of failing.
- Plain ASCII output really is 7-bit, so a mode that silently stopped working is caught.
- Unicode output contains box-drawing characters, so a text-only answer is not mistaken for a
  diagram.
- Nothing but newlines can control the terminal. No escape sequence reaches the transcript.

## Writing files

Nothing is written unless a call asks for it, and the repository is never the default. `formats`
produces files in a private per-process temporary directory created with `mkdtemp`, so diagrams
that quote repository content are not readable by other users of a shared machine. That store is
capped, so a long session cannot fill the temp directory.

Only `save` reaches the repository, and `save.dir` is required: no directory convention holds
across repositories, so the destination has to be named rather than assumed. The directory and
file name come from the model, so both are parsed before anything touches the disk.

| Control | What happens |
| --- | --- |
| Relative paths only | An absolute `save.dir` is refused. |
| No climbing out | A `..` segment is refused, and the resolved path must sit inside the workspace root. |
| No symlink redirect | The deepest existing ancestor is resolved with `realpath` and checked, *before* any directory is created, so a `docs` symlink pointing elsewhere cannot have `mkdir` build the rest of the path on the other side of it. The check runs again after `mkdir`. |
| Bounded file names | The name is slugified from `title` or `basename`: lowercase, letters and digits only, 60 characters, no separators, and no Windows device names. |
| Plain files only | An existing path that is not a regular file, including a symlink, is never overwritten. |
| Atomic writes | Each file is written to a temporary name and renamed, so a reader never sees half a diagram and a failed write leaves the previous version intact. |
| Visible before approval | The approval prompt lists the exact paths, and the tier is `write`. |

Saved SVG is checked before it is written. D2's own documentation calls exported SVG web content,
so `<script>`, `<foreignObject>`, `<image>`, `<iframe>`, `<use>`, and any remote `href` are
refused. Real output contains only embedded WOFF fonts, injected CSS, and namespace URIs.

## Drawing the image

D2 exports PNG by driving a headless browser that Playwright downloads on first use, which
ADR-011 rules out. The image is drawn locally instead, from the SVG this tool already checked.

| Control | What happens |
| --- | --- |
| No browser, no network | resvg draws the SVG in this process. Nothing is fetched or started. |
| Checked input | Only an SVG that passed the checks above is rasterized, so `<script>`, `<image>`, and remote references are already gone. |
| Fonts from the diagram | The faces D2 embedded in the SVG are rebuilt as font files in a fresh temporary directory and passed to the renderer. Every offset in the container is checked against its own length first. |
| Bounded canvas | The draw width is derived from the diagram, capped at 1600 by 2400 pixels, and the resulting PNG is refused past 4 MB. |
| Checked output | The bytes have to be a PNG, with an image header, a complete trailer, an area, and the width that was asked for. A silently ignored option cannot reach the terminal as a broken image. |
| Out of the model's context | The PNG goes to the temp store and is read back when the row is displayed. Its bytes never enter the tool result the model reads. |
| Kept between sessions | The image is also held in the render cache, in a private directory outside the repository, and dropped after a week. |
| Out of the repository | Only `formats: ["png"]` with `save.dir` writes one into the workspace, through the same path checks as any other artifact. |
| Never sent blind | A terminal with no image protocol is not sent an image, and none is drawn for it. |

resvg reads the fonts it is given and nothing else, so a label with no glyph would come out as an
empty box. Rather than let that happen quietly, the characters in the SVG's text are compared
against what the embedded faces can draw. When something is missing, the machine's own fonts are
added and the result says so. That is the case for CJK and emoji: D2 has no glyphs for them
either, and sizes the boxes as if it had.

## Known limits of D2's text renderer

D2's ASCII and Unicode export is beta. Two cases are worth knowing, and both are why the source
check refuses more than security alone would require:

- Block string labels (`|md ... |`) draw an empty box, losing the text.
- `shape: text` keeps its box but loses its label.

When text cannot represent a diagram at all, the tool retries once in plain ASCII and then says
so. It never substitutes a different diagram.
