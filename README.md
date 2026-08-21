# pi-diagram

[![CI](https://github.com/mcuste/pi-diagram/actions/workflows/ci.yml/badge.svg)](https://github.com/mcuste/pi-diagram/actions/workflows/ci.yml)

An extension for the [Pi](https://github.com/earendil-works/pi) and
[Oh My Pi](https://github.com/can1357/oh-my-pi) terminal coding agents. It gives the model one
`diagram` tool that turns declarative [D2](https://d2lang.com) source into a rendered diagram in the
transcript, or into documentation artifacts checked into the repository.

If any of those names are new to you:

- **D2** is a declarative diagram language. Text such as `client -> gateway -> api` compiles to a
  laid-out diagram, and the same language covers containers, sequence diagrams, and SQL tables.
- **Pi** and **Oh My Pi** are terminal coding agents. An **extension** is an npm package they load
  at startup to add tools the model can call.

> **Status: images, text, and files work.** In a terminal that supports inline images the diagram
> itself is shown; everywhere else it is box drawing or plain ASCII. Files land outside the
> repository unless a destination is named. The design being followed is
> [docs/terminal_diagram_tool_proposal.md](docs/terminal_diagram_tool_proposal.md).

## Why

Coding agents explain spatial things in prose: "A calls B, B queues C, C writes D, D emits an event
back to A." The user rebuilds a graph in their head that the agent could have drawn. A fenced
Mermaid block moves the problem rather than solving it, because a terminal shows the source instead
of the picture.

This extension gives the model one tool for that. The model writes the meaning: nodes, edges,
groups, labels, emphasis. The tool owns the appearance: layout engine, theme, spacing, fonts, and
which representation the current terminal can actually display. Diagrams then look consistent
across calls, because the model is not styling them one at a time.

## Requirements

- Node.js 22 or newer
- The D2 CLI, version 0.8.0 or newer, on `PATH` or named by `D2_BIN`

```bash
brew install d2                          # ships 0.8.1
go install github.com/d2lang/d2@v0.8.1   # or a pinned build from source
```

The prebuilt binaries on D2's GitHub releases page stop at 0.7.1, which draws SQL tables as empty
boxes, so they are below the supported floor.

D2 is an external dependency on purpose. The extension never downloads a renderer during a tool
call. Without it, the extension still loads and a call explains how to install it.

## Install

Pi:

```bash
pi install npm:@mcuste/pi-diagram
```

Oh My Pi:

```bash
omp plugin install @mcuste/pi-diagram
```

Or through the Oh My Pi marketplace:

```text
/marketplace add mcuste/pi-diagram
/marketplace install pi-diagram@pi-diagram
```

From a local checkout:

```bash
pnpm install
pi install /absolute/path/to/pi-diagram
omp plugin link /absolute/path/to/pi-diagram
```

## What the tool does

One tool named `diagram`. Give it D2 source and it draws the diagram in the terminal:

```d2
edge: Edge { gateway }
core: Core { api; worker }
edge.gateway -> core.api
core.api -> core.worker: enqueue
```

```text
┌───────────────────┐
│       Edge        │
│                   │
│    ┌──────────┐   │
│    │ gateway  │   │
│    └──────────┘   │
│          │        │
└──────────│────────┘
           │
 ┌─────────│─────────┐
 │       Core        │
 │         ▼         │
 │     ┌──────┐      │
 │     │ api  │      │
 │     └──────┘      │
 │         │         │
 │      enqueue      │
 │         ▼         │
 │    ┌─────────┐    │
 │    │ worker  │    │
 │    └─────────┘    │
 └───────────────────┘
```

Containers, sequence diagrams, SQL tables, class shapes, and state flows all work from the same
language.

| Field | Purpose |
| --- | --- |
| `source` | The diagram, in D2 |
| `title` | Label shown above the diagram |
| `render` | `auto` and `image` show a picture where the terminal can, `unicode` draws box drawing, `ascii` plain 7-bit, `source` echoes the D2 |
| `language` | `d2`. `mermaid` is in the schema but has no adapter yet |
| `profile` | Accepted and reported back; it starts to matter once themes are implemented |
| `formats` | Files to produce: `source`, `svg`, `png`, `txt`. Written outside the repository |
| `save` | Also copy them into the repository. `dir` is required |

## Images in the terminal

On Kitty, Ghostty, WezTerm, iTerm2, and anything else that speaks a terminal image protocol,
`auto` shows the drawn diagram. Everywhere else the same call shows box drawing, and text is
always rendered too, because whether a terminal can display an image is only settled when the
result reaches the screen.

Nothing needs configuring. The terminal's own capabilities decide, and a terminal without an
image protocol is never sent one. Note that a multiplexer between the terminal and the agent has
to forward the protocol: tmux needs `allow-passthrough`, and herdr needs
`experimental.kitty_graphics`.

The image never enters the model's context. It is written to a private temporary directory and
read back when the row is displayed, so a conversation full of diagrams costs the same as a
conversation full of text.

D2 exports PNG by driving a headless browser it downloads on first use, which this tool will not
do during a call. Instead the SVG it already produces is rasterized locally by
[resvg](https://github.com/yisibl/resvg-js), which needs no browser and no network. Labels are
drawn with the fonts the SVG carries, so the picture matches the boxes D2 measured. Characters
those fonts do not cover, such as CJK, fall back to the fonts on the machine and say so.

## Where files go

Most diagrams explain something in passing and should leave nothing behind. So nothing is written
unless it is asked for, and the repository is never the default:

| Call | Files | Approval |
| --- | --- | --- |
| `{ source }` | none, the diagram is only in the transcript | read |
| `{ source, formats: ["svg"] }` | an SVG in a private temp directory, path returned | read |
| `{ source, title, save: { dir: "docs/diagrams" } }` | copied into the repository | write, prompts with the exact files |

`save.dir` has no default. There is no directory convention that holds across repositories, so
the destination has to be named. Only pass `save` when the user asked to keep the diagram.

A saved pair is editable source plus a viewable rendering:

```text
docs/diagrams/request-lifecycle.d2
docs/diagrams/request-lifecycle.svg
```

Markdown then needs no D2 or Mermaid runtime:

```markdown
![Request lifecycle](diagrams/request-lifecycle.svg)
```

For documentation prefer `svg`: it scales, and Markdown renders it anywhere. `png` exists for
places where SVG support is weak.

Repository paths stay inside the workspace. Absolute paths, `..`, and symlinks pointing outside
are all refused.

Layout engine, theme, padding, and font are deliberately not in the schema. They are policy here,
and a model given those knobs spends tokens on styling and produces a different look every call.

## What is deliberately missing

- **Model-drawn images.** The model never emits SVG coordinates or ASCII art directly. It writes
  source, and a renderer lays it out.
- **Imports and external assets.** Diagram source cannot pull in files, local images, or remote
  icons. Those turn a rendering request into file and network access.
- **Interactive editing.** The tool renders; it is not a diagram editor in the terminal.
- **Every D2 feature.** A safe subset is supported, and anything outside it is reported as an error
  the model can correct rather than being silently dropped.

## Documentation

- [Safety model](docs/safety.md)
- [Design proposal](docs/terminal_diagram_tool_proposal.md)
- [Development and release](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
