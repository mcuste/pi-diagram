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

> **Status: scaffold.** The tool contract, project tooling, and release pipeline are in place. The
> renderer is not built yet, so a tool call reports that instead of drawing a diagram.

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
- The [D2 CLI](https://d2lang.com/tour/install) on `PATH`, or a configured path to it

The D2 CLI is an explicit external dependency. The extension never downloads a renderer during a
tool call.

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

One tool named `diagram`, taking diagram source plus a few semantic hints:

| Field | Purpose |
| --- | --- |
| `source` | The diagram, in the language named by `language` |
| `language` | `d2` (default) or `mermaid` for existing content |
| `title` | Label shown with the diagram and used to name saved files |
| `profile` | `explain`, `architecture`, `data`, or `docs`: what the diagram is for |
| `render` | `auto`, `image`, `unicode`, `ascii`, or `source` |
| `save` | Directory, file name stem, and formats to write into the workspace |

`render: auto` shows an inline image where the terminal supports one and Unicode box drawing where
it does not. A call without `save` is a diagram shown only in chat; a call with it also writes
editable source and an SVG, so the diagram survives as documentation.

Layout engine, theme, padding, and font are deliberately not in the schema. They are harness policy,
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

- [Development and release](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
