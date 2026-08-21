> **Document type:** Proposal

# Terminal-Native Diagram Tool for Pi and OMP Harnesses

*D2-first, multi-renderer architecture for LLM-generated diagrams in terminal chat and documentation*

> This Markdown edition is optimized as an implementation handoff for another LLM: all diagrams, schemas, examples, and checklists are represented as text-native Markdown.

> **Decision summary**
>
> Build one `diagram` tool. Use D2 as the primary agent-facing DSL; render deterministically to SVG/PNG and D2 Unicode/ASCII; let Pi/OMP adapters own terminal display; keep Mermaid as a compatibility adapter; do not ask the LLM to draw SVG manually.

Status: Implementation proposal  
Version: 0.1  
Date: 20 August 2026  
Primary audience: LLM implementation agent / harness maintainer  
Target surfaces: Pi, Oh My Pi (OMP), headless/print mode, documentation workflows  

*This document is intentionally written as both a design proposal and an implementation handoff. The final appendix contains a ready-to-paste LLM build prompt and completion checklist.*

# Contents

1. Executive summary
2. Problem statement and goals
3. Design principles
4. Recommended architecture
5. Public tool contract
6. D2 language strategy
7. Rendering pipeline
8. Visual quality and style profiles
9. Terminal and harness behavior
10. Pi integration
11. OMP integration
12. Documentation and artifact workflow
13. Security model
14. Validation, errors, and repair
15. Performance and caching
16. Package/module layout
17. Implementation plan
18. Testing strategy
19. Acceptance criteria
20. Risks and mitigations
21. Architecture decisions
22. Examples
23. Future extensions
24. Source references
Appendix A. LLM implementation handoff prompt
Appendix B. Definition of done checklist

# 1. Executive summary

The goal is to add a first-class `diagram` tool to terminal AI harnesses so an LLM can replace dense explanatory prose with architecture diagrams, relationship diagrams, ER/database diagrams, sequence diagrams, class/object diagrams, state diagrams, and flowcharts. The same source should also be useful for checked-in documentation rather than being a one-off terminal visualization.

The recommended design is D2-first. D2 is a declarative diagram language with a compact syntax, first-class containers, sequence diagrams, SQL tables, class shapes, multiple layout engines, themes, and direct CLI exports to SVG, PNG, PDF, PPTX, GIF, and ASCII. Its ASCII export includes Unicode box drawing and a basic-ASCII mode, although that renderer is explicitly beta today. [D2-EXPORTS]

The public API should remain renderer-agnostic: one tool named `diagram`. The model submits D2 source plus a small number of semantic rendering hints. A shared core validates the source, enforces a safe D2 subset, renders the required outputs, and returns compact metadata. A Pi adapter and an OMP adapter convert those outputs into the harness-native UI representation. On image-capable terminals, show a PNG inline. On text-only terminals, show D2 Unicode/ASCII. For documentation, persist `.d2` source plus `.svg`, with optional `.png` and `.txt` sidecars.

> **Core recommendation**
>
> D2 is the authoring protocol; SVG/PNG/Unicode are compiled views. Never make the LLM generate SVG coordinates as the normal path. Never make terminal escape codes part of the shared core.

## 1.1 Why D2 instead of Mermaid as the primary DSL

| Concern | D2-first decision | Reason |
| --- | --- | --- |
| LLM generation | Use D2 directly | Basic graph syntax is compact and regular; special diagrams reuse the same language rather than introducing separate mini-grammars. |
| Visual quality | Prefer D2 themes + ELK | D2 exposes professional themes and multiple layout engines; ELK provides orthogonal routing and container-aware behavior. [D2-THEMES] [D2-ELK] |
| Database diagrams | First-class | `shape: sql_table` gives schema rows and constraints and allows edges to target columns. [D2-SQL] |
| Sequence diagrams | First-class | `shape: sequence_diagram` keeps the normal object/edge syntax. [D2-SEQUENCE] |
| Terminal fallback | Built in, beta | D2 exports Unicode or standard ASCII from the same source. [D2-EXPORTS] |
| Documentation | Direct SVG/PNG | No browser-side Mermaid renderer is required for the final artifact. |
| Ecosystem compatibility | Keep Mermaid adapter | Accept Mermaid later where existing docs already use it; do not force a migration in v1. |

# 2. Problem statement and goals

## 2.1 Problem

Terminal coding agents are good at explaining systems but often default to long prose when relationships are inherently spatial: “A calls B, B queues C, C writes D, D emits an event back to A.” The user mentally reconstructs a graph that the agent could have shown directly. Existing fenced Mermaid blocks improve authoring but still require an editor or renderer that understands Mermaid; on some terminal or plain-text surfaces the user sees only source code. Stock Mermaid rendering can also be visually underwhelming for architecture documentation.

The desired experience is that the model can call a tool during normal conversation and the transcript contains a rendered diagram appropriate to the current terminal. The exact same semantic source can then be saved as durable documentation artifacts.

## 2.2 Primary goals

- One simple LLM-facing tool named `diagram` that covers architecture, flow, sequence, state, object/class, ER/database, and relationship diagrams.
- High-quality graphical output using deterministic rendering, not model-generated coordinates.
- Useful output in both image-capable and text-only terminals.
- Documentation-friendly artifacts: editable source plus viewable SVG by default.
- Consistent design language controlled by the harness, not improvised by the model.
- Small model-context footprint: the model should receive a compact success/error result, not thousands of characters of its own rendered diagram.
- Safe execution of model-generated D2, with explicit defenses against file imports and external assets.
- Shared implementation core with thin Pi and OMP adapters.
- Graceful operation in interactive TUI, print/headless, SSH, tmux, and terminals where inline images are disabled.

## 2.3 Non-goals for v1

- Interactive drag-and-drop diagram editing inside the TUI.
- Pixel-perfect replacement for Figma, draw.io, or manually curated architecture illustrations.
- Full support for every D2 feature. v1 intentionally exposes a safe subset.
- Automatic bidirectional Mermaid ↔ D2 conversion for all diagram types.
- A custom diagram intermediate representation (IR) before evidence shows that two independent DSL renderers must be losslessly supported.
- Bundling the proprietary TALA layout engine. Use the open ELK engine as the default; TALA may be an opt-in future capability. [D2-TALA]
- Automatic network retrieval of icons or images referenced by model-generated diagram source.

# 3. Design principles

| Principle | Implication |
| --- | --- |
| Semantic source, compiled views | D2 is the source of truth. SVG, PNG, Unicode, and ASCII are render products. |
| Harness owns presentation | The core returns render products; Pi/OMP native components decide how they appear in the transcript. |
| Agent controls meaning, not branding | The model chooses nodes, edges, groups, labels, and emphasis. The tool chooses fonts, themes, padding, and default layout. |
| Progressive capability | Image when supported; Unicode when not; plain ASCII when Unicode is unsuitable; source as last-resort/debug view. |
| Fail visibly and repairably | Rendering errors return concise D2 diagnostics the agent can correct. Never silently substitute a materially different diagram. |
| Secure by default | No imports, arbitrary local assets, external icon URLs, plugins, links, or raw HTML/Markdown features in the MVP safe subset. |
| Deterministic and cacheable | Same normalized source + renderer version + profile yields the same cache key and output. |
| Documentation is a first-class use case | Persist source and SVG in stable, diffable locations when requested. |
| Keep the tool description concise | The tool schema should be easy for models. Detailed style policy belongs in the implementation and optional prompt guidelines. |

# 4. Recommended architecture

The implementation should be split into a harness-agnostic renderer core and harness-specific adapters. The core must not contain Kitty/iTerm escape sequences or TUI components. Pi and OMP already understand their own terminal capabilities and rendering lifecycles; duplicating that logic would create bugs around tmux, fullscreen scrolling, image deletion, and future terminal support.

```text
LLM
  |
  v
diagram tool
  |
  v
diagram-core
  |-- validate + safe-subset preflight
  |-- D2 + ELK render
  |-- SVG / PNG
  `-- Unicode / ASCII
       |
       +--> Pi adapter --> native Image/Text TUI
       +--> OMP adapter -> native Image/Text TUI
       `--> docs -------> .d2 + .svg (+ optional .png/.txt)
```

**Figure 1. Proposed runtime architecture (text-native representation).**

## 4.1 Logical flow

```text
User asks for explanation
        │
        ▼
LLM decides a diagram reduces prose
        │
        ▼
diagram({ source: D2, profile, render })
        │
        ▼
Safe-subset preflight → d2 validate → render
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
      SVG            PNG        Unicode/ASCII
        │              │              │
        ▼              ▼              ▼
     docs/web     Pi/OMP image     text terminal
```

## 4.2 Recommended packages

```text
packages/
  diagram-core/
    src/
      types.ts
      render.ts
      d2/
        runner.ts
        preflight.ts
        profiles.ts
        diagnostics.ts
      cache.ts
      artifacts.ts
      normalize.ts

  diagram-pi/
    src/index.ts          # pi.registerTool + renderCall/renderResult

  diagram-omp/
    src/index.ts          # OMP extension/tool adapter

  diagram-fixtures/
    architecture/
    sequence/
    erd/
    class/
    state/
    flow/
```

If both harnesses live in a monorepo or share a compatible package ecosystem, `diagram-core` should be one package imported by both. If distribution constraints prevent that, keep the same module boundaries and copy as little adapter code as possible.

# 5. Public tool contract

## 5.1 Tool name and intent

> **Public tool name: `diagram`**
>
> Do not expose `render_d2`, `render_svg`, or `render_mermaid` as separate tools unless they are hidden compatibility primitives. The LLM should reason about “make a diagram,” not the renderer pipeline.

## 5.2 Proposed input schema

*Reference TypeScript contract*

```ts
type DiagramInput = {
  /** Diagram source. D2 by default. */
  source: string;

  /** Input language; keep Mermaid for compatibility/future migration. */
  language?: "d2" | "mermaid";

  /** Short label shown with the diagram and used for artifact naming. */
  title?: string;

  /** Harness-owned visual policy, not arbitrary styling. */
  profile?: "explain" | "architecture" | "data" | "docs";

  /** Preferred transcript representation. */
  render?: "auto" | "image" | "unicode" | "ascii" | "source";

  /** Optional persistence request for documentation/work products. */
  save?: {
    dir?: string;
    basename?: string;
    formats?: Array<"source" | "svg" | "png" | "txt">;
  };
};
```

## 5.3 Defaults

| Field | Default | Policy |
| --- | --- | --- |
| language | `d2` | D2 is the preferred native language. |
| profile | `explain` | Optimized for compact in-conversation comprehension. |
| render | `auto` | Adapter chooses image when usable; otherwise Unicode. |
| save | unset | Ephemeral transcript diagram unless the user/documentation task needs persistent artifacts. |
| save.formats | `source`, `svg` | If persistence is requested, retain editable D2 and viewable SVG. |
| layout | not public | ELK by policy; model should not normally choose layout engines. |
| theme | not public | Profile/harness controls light/dark rendering. |

## 5.4 Why the schema stays small

Do not expose dozens of D2 CLI flags to the LLM. Layout engine, theme IDs, padding, sketch mode, centering, font choice, and export internals are renderer policy. A model given these knobs will waste tokens styling and produce inconsistent results. The only public rendering hint should be semantic (`profile`) plus a representation preference (`render`).

## 5.5 Tool description suggested for the model

> Create and render a diagram from declarative source. Prefer D2. Use this tool when architecture, relationships, sequence, data flow, state transitions, schemas, or process flow are easier to understand visually than as prose. Keep diagrams focused on the user’s question; omit incidental implementation detail. Do not spend tokens on cosmetic styling unless it communicates meaning. The harness applies a consistent visual profile automatically.

## 5.6 Result contract: model content vs UI details

```ts
type DiagramResultDetails = {
  language: "d2" | "mermaid";
  title?: string;
  renderedAs: "image" | "unicode" | "ascii" | "source";
  sourceHash: string;
  diagnostics?: Array<{ line?: number; column?: number; message: string }>;
  outputs: {
    svgPath?: string;
    pngPath?: string;
    textPath?: string;
    sourcePath?: string;
  };
  textPreview?: string;       // only when text rendering is needed
  widthCells?: number;
  heightCells?: number;
};

// Content sent back to the model should stay compact:
content: [{
  type: "text",
  text: "Rendered ‘Request lifecycle’ successfully (image; 8 nodes, 9 edges)."
}]
```

Pi explicitly separates tool `content` (sent to the LLM) from `details` (for rendering/state), and supports custom `renderCall`/`renderResult`. Use this separation so a large ASCII diagram or base64 PNG does not re-enter the model context. [PI-EXTENSIONS]

# 6. D2 language strategy

## 6.1 D2 is the primary authoring protocol

D2 should be the format the agent generates in normal operation. The syntax is declarative and compact: nodes are identifiers or maps, edges use arrows, containers are maps, sequence diagrams use `shape: sequence_diagram`, SQL/ER tables use `shape: sql_table`, and class diagrams use the class shape. This allows one general language instead of a separate grammar per diagram category. [D2-SEQUENCE] [D2-SQL]

### Basic architecture

```d2
client -> gateway
gateway -> api
api -> cache
api -> database
```

### Containerized architecture

```d2
cloud: {
  gateway
  app: {
    api
    worker
  }
  data: {
    cache
    database
  }
}

cloud.gateway -> cloud.app.api
cloud.app.api -> cloud.data.cache
cloud.app.api -> cloud.data.database
cloud.app.api -> cloud.app.worker
```

### Sequence diagram

```d2
request lifecycle: {
  shape: sequence_diagram
  browser -> api: POST /orders
  api -> database: insert order
  database -> api: order_id
  api -> browser: 201 Created
}
```

### ER/database diagram

```d2
users: {
  shape: sql_table
  id: uuid {constraint: primary_key}
  email: string {constraint: unique}
}
orders: {
  shape: sql_table
  id: uuid {constraint: primary_key}
  user_id: uuid {constraint: foreign_key}
}
orders.user_id -> users.id
```

## 6.2 Safe D2 subset for v1

A tool receiving model-generated diagram code should not expose the full D2 language by default. D2 supports file imports, local images, and arbitrary URL-valued icons. That is convenient for human-authored diagrams but creates file- and network-access surfaces in an agent tool. [D2-IMPORTS] [D2-ICONS]

| Feature | v1 policy | Rationale |
| --- | --- | --- |
| Nodes, edges, labels | Allow | Core requirement. |
| Containers | Allow | Required for architecture grouping. |
| Sequence diagrams | Allow | Core use case. |
| SQL tables | Allow | Core ER/database use case. |
| Class shapes | Allow | Core object relationship use case. |
| Built-in shapes | Allowlist | Permit common geometric/software shapes; avoid exotic features until tested. |
| Styles | Restricted | Allow semantic style fields if needed; profiles remain authoritative. |
| Imports `@...` | Reject | D2 imports can read relative and absolute `.d2` files. [D2-IMPORTS] |
| `icon:` / external image URLs | Reject | D2 accepts arbitrary URLs and local image paths. [D2-ICONS] |
| `shape: image` | Reject | Prevents local/remote asset loading in v1. |
| Links | Reject | Avoid generated clickable navigation/security ambiguity. |
| Markdown/HTML-rich labels | Reject or tightly constrain | Reduces SVG/foreignObject attack surface and cross-viewer inconsistencies. |
| TALA | Reject by default | Separate proprietary dependency; not needed for MVP. [D2-TALA] |
| Plugins/custom layout executables | Reject | No arbitrary executable extension points. |

## 6.3 Mermaid compatibility

Mermaid should remain an accepted future/compatibility input because users may paste existing Mermaid blocks or ask the agent to update an existing Mermaid-backed document. Treat it as an adapter, not as the required intermediate representation. A Mermaid adapter may either render Mermaid directly or translate only supported subsets to D2; it must report when conversion is lossy. Do not promise general Mermaid → D2 equivalence.

> **MVP scope choice**
>
> Implement `language: "d2"` first. Keep the schema enum ready for `mermaid`, but it is acceptable for the initial build to return “Mermaid input not enabled” until the adapter is implemented.

## 6.4 Do not build a custom Diagram IR yet

A normalized graph/sequence/schema IR is attractive long-term, but it significantly expands scope: the project would need parsers, semantic preservation rules, serializers, and feature negotiation across diagram types. Introduce an IR only if future requirements demand multiple interchangeable source languages or renderers with round-trip guarantees. For v1, D2 source itself is the semantic representation.

# 7. Rendering pipeline

## 7.1 Required pipeline

1. Normalize input: trim trailing whitespace, normalize line endings to LF, apply a size limit, and establish the selected profile.
1. Run safe-subset preflight before invoking D2. Reject disallowed syntax/features with line-oriented diagnostics.
1. Write the source to an isolated temporary directory as `input.d2`. Never run D2 with the project root as its working directory.
1. Run `d2 validate input.d2` and use the process exit status, not output-file presence, to decide success. D2 documentation warns that partial output can exist even on failed renders. [D2-CLI]
1. Render the representation requested by the adapter: SVG for artifacts, PNG for image components, ASCII/Unicode for text terminals. D2 can write SVG/PNG/ASCII to stdout. [D2-CLI]
1. Enforce process timeout, stdout/stderr byte caps, and cancellation via the harness abort signal.
1. Store render products in the cache/artifact layer; return only compact metadata to the agent context.
1. The harness adapter renders the product using its native component system.

## 7.2 Recommended D2 invocation

```ts
// Pseudocode — use spawn/execFile with shell: false.
const args = [
  "--layout", "elk",
  "--theme", selectedThemeId,
  "--timeout", "10",
  "--stdout-format", format,  // svg | png | ascii
  inputPath,
  "-",
];

spawn(d2Binary, args, {
  cwd: isolatedTempDir,
  shell: false,
  env: sanitizedEnv,
  signal,
});
```

The exact theme IDs should live in configuration/profile definitions, not in model input. Use CLI flags rather than trusting `vars.d2-config` inside model-generated source because D2 documents that flags and environment variables take precedence over source configuration. [D2-VARS]

## 7.3 Output selection

| Need | Preferred output | Fallback |
| --- | --- | --- |
| Pi/OMP transcript with image support | PNG | Unicode |
| Pi/OMP transcript without image support | Unicode D2 ASCII mode | Basic ASCII |
| Plain/log/CI output | Basic ASCII or Unicode by config | Source block + concise failure note |
| Markdown documentation | SVG + `.d2` source | PNG if downstream SVG support is weak |
| Browser/docs site | SVG | PNG |
| Copy/paste to issue or terminal chat | Unicode | Basic ASCII |

## 7.4 D2 ASCII is a capability, not a guarantee

D2’s ASCII export is currently documented as beta and may render some diagrams incorrectly. It supports an extended Unicode mode by default and a standard ASCII mode for maximum compatibility; ASCII rendering is routed through ELK or TALA. [D2-EXPORTS] Therefore `render: auto` should prefer image output when a harness can display it. The text fallback must include graceful failure behavior rather than assuming parity with SVG.

> **Text fallback behavior**
>
> If Unicode rendering fails, try standard ASCII once. If that also fails, render a compact textual result explaining that the graphical artifact was produced but the text renderer could not represent it; in expanded/debug view show the D2 source and diagnostic. Do not fabricate a different graph.

## 7.5 SVG caveat

D2’s SVG export includes injected CSS and can use HTML `foreignObject` elements for Markdown; the D2 documentation notes that exported SVG is primarily intended for web contexts and may not look identical in non-web tools such as vector editors. [D2-EXPORTS] For documentation, SVG remains the preferred default because it is scalable and easy for Markdown/browser previews, but provide optional PNG generation for environments with weak SVG support. Restrict Markdown-rich labels in the safe subset to reduce this variability.

# 8. Visual quality and style profiles

## 8.1 The tool owns the visual language

The user’s main complaint with Mermaid is aesthetic quality. The design should prevent the same problem from reappearing through random D2 styling. The LLM should describe semantics, while the renderer applies a small set of opinionated profiles. D2 provides theme selection and adaptive dark-theme support, and the CLI can override in-source configuration. [D2-THEMES] [D2-VARS]

## 8.2 Recommended profiles

| Profile | Use | Rendering policy |
| --- | --- | --- |
| explain | Inline conversational diagrams | Compact, generous whitespace, low visual noise, modest labels, no decorative icons. |
| architecture | System/component views | ELK, orthogonal routing, clear containers, slightly larger spacing, subtle hierarchy. |
| data | ER/schema/object relationships | ELK, table/class shapes, exact-column routing where supported, dense but readable. |
| docs | Checked-in documentation | Neutral professional theme, adaptive light/dark SVG, generous padding, stable labels, print-safe contrast. |

## 8.3 Default layout: ELK

Override D2’s default Dagre layout with ELK for this tool. D2 describes ELK as actively maintained, fast, orthogonal, strong at minimizing crossings, and better at native container-to-container routing; it also routes SQL-table edges to exact columns. [D2-ELK] Dagre remains a potential speed fallback for extremely simple graphs, but introducing profile-dependent layout too early can make output less predictable.

## 8.4 Styling rules for the model

- Do not set arbitrary colors for every node.
- Do not hard-code theme IDs or fonts.
- Use grouping/containers and labels to express hierarchy before using color.
- Use style only for semantic emphasis: e.g., error path, deprecated component, external boundary.
- Prefer short labels; place detail in surrounding prose.
- Keep inline explanation diagrams smaller than documentation diagrams.
- Do not include decorative icons in v1 because remote/local icon references are disallowed by the security policy.

## 8.5 Complexity budgets

| Diagram | Inline target | Hard guidance |
| --- | --- | --- |
| Architecture | 5–15 major nodes | Split diagrams above ~20 major nodes unless the user explicitly asks for a full map. |
| Sequence | 2–6 participants; 5–15 messages | Collapse repeated internal calls; show the causal path relevant to the explanation. |
| ER/data | 3–10 tables | Show only columns relevant to relationships unless schema documentation is the task. |
| Class/object | 3–12 types | Focus on ownership/inheritance/association relevant to the question. |
| Flow/state | 5–20 steps/states | Factor independent subflows into separate diagrams. |
| Dependency graph | Up to ~20 visible nodes | Prefer grouped subsystems over exhaustive package-level graphs. |

# 9. Terminal and harness behavior

## 9.1 Do not implement terminal protocols in diagram-core

The shared core’s contract ends at PNG/text artifacts. Pi already has a native `Image` TUI component that renders images in supported terminals including Kitty, iTerm2, Ghostty, WezTerm, and Warp. [PI-TUI] Pi also handles different behavior in regular and fullscreen modes; for example, current fullscreen mode supports Kitty-protocol terminals but intentionally degrades iTerm2 image placements because of scrolling/deletion constraints. [PI-USAGE] This is exactly why the diagram package should delegate presentation to the harness.

## 9.2 Capability abstraction

```ts
interface DiagramDisplayCapabilities {
  showImages: boolean;
  unicode: boolean;
  widthCells: number;
  heightCells?: number;
  mode?: "interactive" | "print" | "rpc" | "acp";
}

function chooseRepresentation(
  requested: DiagramInput["render"],
  caps: DiagramDisplayCapabilities
): "png" | "unicode" | "ascii" | "source";
```

For Pi, the adapter should use Pi’s existing `context.showImages`/terminal capability state rather than re-detecting `TERM_PROGRAM`. For OMP, use OMP’s existing image/TUI capability state and the same rendering primitives used by built-in tools. A generic adapter may inspect terminal capabilities, but the shared core should not.

## 9.3 Resize behavior

Image output should be scaled by the native TUI component to a maximum cell width. Text output should be rendered for the current width at tool execution time. If the TUI supports re-render callbacks and width changes, consider a later enhancement that regenerates text output for the new width. Do not block the MVP on perfect live reflow; cached source makes regeneration cheap.

## 9.4 Expanded view

Collapsed tool output should show the diagram itself with a short title and status. Expanded view may add source, render format, save paths, and diagnostics. Keep debug metadata out of the default transcript.

# 10. Pi integration

## 10.1 Extension model

Pi extensions can register custom LLM tools with `pi.registerTool()` and provide custom TUI rendering through `renderCall` and `renderResult`. Tool results distinguish `content` sent to the LLM from `details` used for rendering and state. [PI-EXTENSIONS] This maps directly onto the proposed architecture.

## 10.2 Pi adapter skeleton

*Illustrative skeleton; exact imports/capability access should follow current Pi APIs.*

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "diagram",
    label: "Diagram",
    description: DIAGRAM_TOOL_DESCRIPTION,
    parameters: DiagramInputSchema,

    async execute(_id, input, signal, _onUpdate, ctx) {
      const caps = getPiDisplayCapabilities(ctx);
      const result = await diagramCore.render(input, caps, signal);
      return {
        content: [{ type: "text", text: result.modelSummary }],
        details: result.details,
      };
    },

    renderCall(args, theme, context) {
      return renderDiagramCall(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      // Native Image for PNG; Text/Markdown for Unicode/ASCII.
      // Expanded state reveals source, paths, and diagnostics.
      return renderDiagramResult(result, options, theme, context);
    },
  });
}
```

## 10.3 Pi image rendering

Pi’s `Image` component accepts base64 image data and supports maximum dimensions in terminal cells. [PI-TUI] Avoid permanently storing huge base64 blobs in session details if a local cache path plus lightweight load-on-render strategy is possible. If `renderResult` requires synchronous image data, keep a bounded encoded representation in the tool result only after measuring session-size impact; otherwise load from a cache path in the adapter.

## 10.4 Pi mode behavior

| Mode | Expected behavior |
| --- | --- |
| Regular TUI | Use Pi Image component when `showImages` is true; otherwise Unicode. |
| Fullscreen TUI | Trust Pi’s native image capability and fallback rules; do not force iTerm2 escape sequences. [PI-USAGE] |
| Print / `-p` | Emit Unicode/ASCII or a concise artifact path; never emit terminal image protocol sequences. |
| SDK consumer | Return structured details and let host decide representation. |
| Unsupported terminal | Unicode or standard ASCII fallback. |

# 11. OMP integration

## 11.1 Current OMP baseline

OMP already exposes a gated `render_mermaid` tool described as “Mermaid source to terminal-friendly ASCII or PNG.” [OMP-HOME] This validates the product pattern: diagram source enters a tool and the tool selects a terminal-appropriate representation. The new design generalizes that capability around a renderer-agnostic `diagram` contract and D2-first source.

OMP’s current codebase exposes TypeScript extensions, custom tools, TUI primitives, interactive/print/RPC modes, artifact management, and tool result metadata. Its development guide describes built-in tool factories and a tool-result builder/meta layer. [OMP-DEV] Prefer implementing the feature as an extension first unless integration with built-in artifacts/image rendering requires core hooks that extensions cannot access cleanly.

## 11.2 OMP migration options

| Option | Recommendation | Notes |
| --- | --- | --- |
| New `diagram` extension alongside `render_mermaid` | Best MVP | Low risk. Keep existing Mermaid tool intact while validating D2 UX. |
| Generalize built-in `render_mermaid` into `diagram` | Phase 2 | Best long-term product shape if D2 proves successful. |
| Replace Mermaid immediately | Not recommended | Breaks existing prompts/config and loses compatibility before the new path is proven. |
| Keep both public forever | Probably not | Creates tool-choice ambiguity for the model; eventually keep one public tool with language adapters. |

## 11.3 OMP modes

Interactive OMP should show image/text through existing TUI tool rendering. Print mode should render Unicode/ASCII or artifact references. RPC/ACP should expose structured metadata and stable artifact paths/URIs rather than terminal escape sequences. If OMP’s artifact store is available to extensions, use it instead of inventing a parallel cache/persistence mechanism.

# 12. Documentation and artifact workflow

## 12.1 Source + compiled artifact

> **Documentation rule**
>
> When a diagram is intended to persist, save both editable source and a rendered artifact. Default bundle: `name.d2` + `name.svg`.

This solves the original editor problem without abandoning text-native authoring. D2 source remains diffable and LLM-editable; ordinary Markdown can reference the SVG directly, so the documentation consumer does not need a Mermaid runtime or D2 plugin.

## 12.2 Recommended directory convention

```text
docs/
  architecture.md
  diagrams/
    request-lifecycle.d2
    request-lifecycle.svg
    request-lifecycle.png   # optional compatibility
    request-lifecycle.txt   # optional terminal/plain-text sidecar
```

## 12.3 Markdown embedding

```markdown
## Request lifecycle

![Request lifecycle](diagrams/request-lifecycle.svg)

The API validates the request before enqueuing background work…
```

A documentation generator may optionally preserve a fenced D2 block for D2-aware editors, but the universal viewing path should be the SVG image reference. The `.d2` source can live beside the image rather than inside every Markdown page.

## 12.4 Stable filenames

- Use a slug derived from `save.basename` or title; never derive paths directly from unsanitized model text.
- Restrict `save.dir` to the project/workspace root unless the user explicitly authorizes a broader path.
- If a filename exists and content differs, follow harness edit/overwrite policy rather than silently clobbering.
- Consider a generated comment in adjacent docs or a small manifest linking source hash to rendered artifacts.
- Normalize source with `d2 fmt` only if it does not unexpectedly rewrite user-maintained files; for generated sources, formatting before persistence is preferred.

## 12.5 Artifact metadata

```json
{
  "engine": "d2",
  "rendererVersion": "<detected version>",
  "profile": "architecture",
  "sourceHash": "sha256:…",
  "layout": "elk",
  "outputs": ["request-lifecycle.d2", "request-lifecycle.svg"]
}
```

This manifest is optional for the MVP. The cache should track equivalent metadata internally even if no manifest is checked into the repository.

# 13. Security model

## 13.1 Threat model

The D2 source is produced by an LLM and may incorporate untrusted user/repository text. Treat it as untrusted input. The renderer is a subprocess with filesystem and network capabilities unless constrained. D2’s language supports local/absolute imports and local or URL-based image/icon references. [D2-IMPORTS] [D2-ICONS] A secure implementation must prevent diagram generation from becoming an implicit file-read, network-fetch, or arbitrary-plugin channel.

## 13.2 Required controls

| Control | Requirement |
| --- | --- |
| No shell | Invoke D2 with `spawn`/`execFile` argument arrays and `shell: false`. Never build a shell command string from model input. |
| Isolated working directory | Create a fresh temp directory; write only `input.d2`; use that directory as `cwd`. |
| Safe-subset tokenizer | Reject imports, external/local asset syntax, links, rich/HTML-like content, and plugin/layout escape hatches before invoking D2. |
| Absolute path defense | Do not rely on isolated `cwd` alone; imports support absolute paths. [D2-IMPORTS] |
| No network assets | Reject URL-bearing icon/image fields. Removing proxy variables is defense-in-depth, not a network sandbox. |
| Timeout | Use both D2 `--timeout` and harness process cancellation; default ~10s for conversational diagrams, configurable. |
| Output caps | Bound stdout/stderr and generated artifact sizes; abort on excessive output. |
| Input cap | Bound source length (e.g., 64–128 KiB) and optionally node/edge complexity to prevent pathological layouts. |
| Fixed layout engine | Use built-in ELK by policy; do not permit model-selected external layout plugins. |
| Sanitized save paths | Resolve target path, ensure it remains inside allowed workspace roots, and apply existing overwrite permissions. |
| Renderer version check | Require a supported D2 version range and fail with installation guidance if absent/incompatible. |
| SVG handling | Treat generated SVG as active-ish web content. Avoid raw HTML/links in safe subset and use trusted embedding contexts; consider sanitization if later allowing richer labels. |

## 13.3 Preflight implementation guidance

Do not implement the security gate as a handful of naive regular expressions over raw text. At minimum, build a small tokenizer that understands D2 strings and comments so `@` inside a quoted email address is not mistaken for an import. A robust longer-term option is to reuse D2’s parser/AST in a small helper, but that may require a Go helper or a suitable library boundary. The MVP tokenizer can be conservative: reject ambiguous constructs rather than attempting to support every D2 feature.

```text
preflight(source):
  tokenize while respecting quoted strings and comments
  reject import tokens outside strings/comments
  reject keys: icon, link
  reject shape: image
  reject unsupported rich-label delimiters
  reject suspicious absolute/path-like constructs in asset contexts
  enforce allowed feature set
  return diagnostics with line/column
```

## 13.4 Defense in depth

- Use a dedicated unprivileged process/container sandbox if the harness already provides one.
- On supported platforms, optional OS-level network/filesystem sandboxing can make external access impossible even if the preflight misses a syntax case.
- Do not pass secrets or the full parent environment to D2; use a minimal environment required for execution.
- Keep temporary directories outside the project and delete them after the render unless diagnostics require retention in debug mode.
- Never open generated links automatically.

# 14. Validation, errors, and repair

## 14.1 Error taxonomy

| Class | Example | Agent-facing behavior |
| --- | --- | --- |
| Input policy | Disallowed import/icon | Return a concise security diagnostic and tell the model to express the same concept with built-in shapes/labels. |
| Syntax | Missing brace / invalid edge | Return line/column and D2 diagnostic; model can correct source. |
| Render/layout | D2 exits non-zero | Return relevant stderr, capped and normalized. |
| Text renderer | ASCII beta limitation | Attempt standard ASCII once, then surface graphical artifact/source fallback. |
| Dependency | D2 binary missing | Return install/config guidance; do not attempt arbitrary downloads during tool execution. |
| Timeout | Layout exceeds budget | Suggest reducing diagram size or splitting it. |
| Save path | Outside workspace / overwrite denied | Render can still succeed ephemerally; saving returns a separate path policy error. |
| Harness display | Image disabled/unsupported | Fall back to text automatically; not an error. |

## 14.2 Repair loop

The tool itself should not call another LLM. It returns deterministic diagnostics to the same agent, which may make one corrected tool call. Prompt guidance should discourage endless diagram repair loops: after two failed render attempts, the agent should either simplify the source or explain the limitation and proceed with prose.

## 14.3 Diagnostic normalization

```json
{
  "code": "D2_SYNTAX",
  "message": "unexpected token near 'database'",
  "line": 12,
  "column": 8,
  "hint": "Check the preceding map/brace or quote the label."
}
```

Strip temporary-directory prefixes from messages before returning them. Preserve enough of the original D2 diagnostic for the agent to fix the source, but never expose unrelated filesystem paths.

# 15. Performance and caching

## 15.1 Cache key

```text
sha256(
  normalizedSource + "\0" +
  language + "\0" +
  profile + "\0" +
  selectedRepresentation + "\0" +
  d2Version + "\0" +
  rendererPolicyVersion
)
```

## 15.2 Cache policy

- Cache SVG/PNG/text independently because a terminal may request another representation later.
- Keep an LRU size bound (for example, 100–250 MB configurable) and age-based cleanup.
- Persistent documentation outputs are not cache entries; they are explicit artifacts copied/written from cached products.
- Cache only after successful validation and render.
- Hash the renderer policy version so theme/layout changes invalidate old output.
- Use atomic writes/renames for cache and persistent artifacts.

## 15.3 Latency target

Conversational diagrams should feel like ordinary tool calls, not build jobs. A practical target is sub-second to a few seconds for typical diagrams, with a default hard timeout around 10 seconds. Measure separately: preflight, validation, render, TUI decode/display. Do not optimize by removing validation or security checks.

# 16. Package/module layout

## 16.1 `diagram-core`

| Module | Responsibility |
| --- | --- |
| types.ts | Public input/result types and capability interface. |
| normalize.ts | Line endings, trimming, source-size limits, safe title/basename helpers. |
| d2/preflight.ts | Safe D2 subset tokenizer and policy diagnostics. |
| d2/runner.ts | Binary discovery/version check; validate/render subprocess management. |
| d2/profiles.ts | ELK/theme/padding policy for explain/architecture/data/docs. |
| d2/diagnostics.ts | Parse/cap/normalize D2 stderr. |
| render.ts | Representation selection and orchestration. |
| cache.ts | Content-addressed render cache. |
| artifacts.ts | Safe project path resolution and persistent output writing. |

## 16.2 Adapter responsibilities

| Shared core | Pi adapter | OMP adapter |
| --- | --- | --- |
| Validate D2 | Register tool | Register tool/extension |
| Run renderer | Read Pi display state | Read OMP display state |
| Produce SVG/PNG/text | Create `Image`/`Text` component | Use OMP native tool/TUI renderer |
| Cache outputs | Implement expanded/collapsed view | Implement expanded/collapsed view |
| Persist artifacts | Map abort signal | Map abort signal/artifacts |
| Return diagnostics | Keep model content compact | Keep model content compact |

## 16.3 Dependency resolution

Support an explicit configuration path such as `diagram.d2Path` or `D2_BIN`, then fall back to `d2` on `PATH`. On startup or first call, run `d2 --version` and record the version. Do not auto-download executables from inside the tool. Installation may be documented separately or handled by the harness/package manager.

# 17. Implementation plan

## Phase 0 — Spike (prove the UX)

- Create a standalone TypeScript function that accepts D2 and returns SVG, PNG, and Unicode text using the installed D2 CLI.
- Create 12–20 fixture diagrams spanning architecture, flow, sequence, ER, class, state, nested containers, long labels, and error cases.
- Compare ELK vs Dagre output; confirm ELK as default unless evidence contradicts the proposal.
- Measure D2 ASCII quality for the fixture set and identify cases that need fallback messaging.
- Prototype one Pi extension using native Image/Text rendering and one OMP extension/tool card.
- Confirm session-size impact of storing PNG base64 versus cache paths.
> **Spike exit criterion**
>
> A user can ask “show me the request path,” see a polished inline diagram in an image-capable terminal, and see a comprehensible Unicode fallback in a text-only terminal, from the same D2 source.

## Phase 1 — MVP

- Implement `diagram-core` with D2-only input, safe-subset preflight, validation, ELK render, profiles, cache, and artifact persistence.
- Implement Pi adapter with `diagram` tool, compact model result, custom `renderCall`/`renderResult`, image/text selection, expanded details.
- Implement OMP adapter alongside existing `render_mermaid` without removing it.
- Add project/global settings for enablement, D2 path, default profile, artifact directory policy, cache limits, and optional forced text mode.
- Add unit tests, golden/snapshot fixtures, integration tests, and security tests.
- Write user documentation with D2 examples and fallback behavior.

## Phase 2 — Product polish

- Add Mermaid input adapter for existing user content.
- Generalize/deprecate OMP `render_mermaid` behind `diagram` after compatibility testing.
- Add profile tuning based on real-world diagrams and light/dark terminal themes.
- Improve text fallback for unsupported D2 ASCII cases or integrate a second text renderer if evidence justifies it.
- Add documentation helper command to regenerate all `.svg` files from sibling `.d2` sources.
- Add optional diff/re-render workflow when source files change.

## Phase 3 — Only if demanded

- Introduce a normalized Diagram IR if multiple source languages need lossless interchange.
- Add richer safe assets/icons through an allowlisted local asset registry rather than arbitrary paths/URLs.
- Add interactive zoom/pan/fullscreen diagram inspection where the TUI supports it.
- Add optional alternate rendering engines such as a custom SVG renderer or D2-compatible backend.

# 18. Testing strategy

## 18.1 Fixture matrix

| Fixture | SVG/PNG | Unicode | Security/edge |
| --- | --- | --- | --- |
| Simple left-to-right flow | Required | Required | — |
| Nested architecture containers | Required | Required | Long container names |
| Sequence diagram | Required | Required if supported well | Long message labels |
| ERD / sql_table | Required | Best effort + checked | FK edges to columns |
| Class/object relationships | Required | Best effort | Inheritance/association labels |
| State/flow with cycles | Required | Required | Cycles/crossings |
| 20-node architecture | Required | Best effort | Performance/timeout |
| Unicode labels | Required | Required | Wide glyphs/CJK/emoji policy |
| Very long labels | Required | Required | Wrapping/width |
| Invalid D2 | No output | No output | Diagnostic line/column |
| Relative import | Blocked | Blocked | Security |
| Absolute import | Blocked | Blocked | Security |
| Remote icon URL | Blocked | Blocked | Security |
| Local image | Blocked | Blocked | Security |

## 18.2 Test layers

- Unit: tokenizer/preflight, path safety, normalization, profile selection, cache keys, diagnostic parsing.
- Process integration: execute a pinned/supported D2 binary against fixtures; assert exit codes, output MIME/signatures, timeout handling, cancellation, stdout caps.
- Golden visual: store selected SVG or raster snapshots for representative fixtures; review intentionally when renderer/profile changes.
- Terminal text snapshots: Unicode and standard ASCII outputs for a stable subset; allow version-gated updates when D2 changes.
- Pi integration: tool registration, collapsed/expanded result, image-off fallback, print mode behavior, cancellation.
- OMP integration: interactive card, print/RPC behavior, artifact handling, coexistence with `render_mermaid`.
- Security: malicious D2 corpus covering imports, absolute paths, URL icons/images, rich labels, oversized input, output explosion attempts.
- Documentation: saved `.d2` and `.svg` pairs have stable names and Markdown references resolve.

## 18.3 Manual terminal matrix

| Environment | Expected |
| --- | --- |
| Ghostty / Kitty / WezTerm under Pi regular mode | Inline PNG through native Pi Image component. |
| iTerm2 under Pi regular mode | Inline image if Pi reports support. |
| Pi fullscreen mode | Follow Pi’s current native capability/fallback behavior. [PI-USAGE] |
| tmux | Use harness behavior; do not bypass it with raw protocol sequences. |
| VS Code/unsupported image terminal | Unicode text. |
| SSH session | Image only if harness reports it works; otherwise text. |
| CI / redirected stdout | No graphics protocol; text or artifact path. |
| OMP interactive | Native image/text tool rendering. |
| OMP print/RPC/ACP | Text/structured artifact metadata, no escape-sequence assumptions. |

# 19. Acceptance criteria

## 19.1 Functional

- An LLM can call one `diagram` tool with D2 source and no renderer-specific knowledge.
- Architecture, flow, sequence, ER/database, and class/object fixture diagrams render successfully to SVG and PNG.
- `render: auto` shows an image through the harness when native image display is available and enabled.
- `render: auto` shows Unicode text when image display is unavailable.
- `render: ascii` emits plain 7-bit ASCII box/arrow output where D2 supports the diagram.
- Persistent mode writes `.d2` and `.svg` by default and returns stable paths.
- D2 validation errors return actionable line-oriented diagnostics.
- Tool model content remains compact and does not include base64 or full ASCII diagrams unless explicitly requested/debugging.

## 19.2 Security

- Relative and absolute D2 imports are rejected before D2 runs.
- Local and remote images/icons are rejected in the MVP safe subset.
- D2 subprocess is never invoked through a shell.
- Render runs in an isolated temporary directory with bounded input/output/time.
- Save paths cannot escape configured workspace roots.
- No renderer auto-download occurs during a diagram tool call.

## 19.3 UX

- Diagrams are visually consistent across calls because the renderer, not the LLM, owns themes/layout defaults.
- Collapsed tool rows do not drown the transcript in source/debug information.
- Expanded view exposes source, output format, saved paths, and diagnostics.
- When text rendering cannot represent a diagram, the user receives an explicit fallback instead of broken box art.
- Documentation consumers can view SVG without a Mermaid/D2 runtime in the Markdown renderer.

# 20. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| D2 ASCII renderer is beta | Text-only diagrams can be malformed | Prefer image when possible; fixture-test supported classes; retry standard ASCII; explicit fallback. |
| D2 binary dependency | Install friction/version drift | Configurable path; version check; documented supported range; no auto-download. |
| Generated D2 uses unsupported features | Frequent tool failures | Strong tool description; safe-subset examples; actionable diagnostics; model repair guidance. |
| Security preflight misses syntax | Potential file/network access | Conservative tokenizer, isolated cwd, minimal env, optional OS sandbox, dedicated malicious-input tests. |
| SVG differs across viewers | Docs inconsistency | Restrict rich labels; validate in target Markdown/browser; optional PNG sidecar. |
| Session bloat from images | Large history files | Cache paths/handles instead of base64 where possible; compact details; bounded cache. |
| Overuse by the model | Noisy conversations | Tool prompt criteria + complexity budgets; diagrams should replace prose, not decorate it. |
| OMP/Pi APIs diverge | Adapter duplication | Keep core pure; isolate adapter-specific code; integration tests per harness. |
| Layout changes across D2 versions | Visual diffs | Record renderer version; golden tests; supported-version range; intentional update process. |

# 21. Architecture decisions (ADRs)

| ADR | Decision | Status |
| --- | --- | --- |
| ADR-001 | Expose one public `diagram` tool. | Accepted |
| ADR-002 | Use D2 as primary agent-facing DSL. | Accepted |
| ADR-003 | Treat SVG/PNG/text as deterministic render products, not LLM-authored output. | Accepted |
| ADR-004 | Use ELK as default layout engine. | Accepted for MVP |
| ADR-005 | Keep Mermaid as compatibility adapter, not mandatory intermediate. | Accepted |
| ADR-006 | Do not introduce custom Diagram IR in MVP. | Accepted |
| ADR-007 | Core never emits terminal graphics escape sequences. | Accepted |
| ADR-008 | Harness adapters own image/text transcript rendering. | Accepted |
| ADR-009 | Persistent docs default to source + SVG. | Accepted |
| ADR-010 | Run only a safe D2 subset; reject imports/assets/links in v1. | Accepted |
| ADR-011 | D2 CLI is an explicit external dependency; no runtime auto-download. | Accepted |
| ADR-012 | Text rendering is best-effort because D2 ASCII is beta. | Accepted |

# 22. End-to-end examples

## 22.1 User explanation: architecture

User: “Where does caching happen in this request path?”

```ts
diagram({
  title: "Request path",
  profile: "explain",
  source: `
client -> api
api -> cache: lookup
api -> database: cache miss
database -> api
api -> cache: populate
api -> client
`
})
```

Expected conversational response: one or two sentences around the rendered diagram. The diagram replaces a paragraph-by-paragraph walkthrough; the prose calls out only the important conclusion.

## 22.2 Sequence explanation

```d2
checkout: {
  shape: sequence_diagram
  browser -> api: POST /checkout
  api -> inventory: reserve
  inventory -> api: reserved
  api -> payments: authorize
  payments -> api: approved
  api -> browser: order confirmed
}
```

The model should not add implementation-internal RPCs unless they change the explanation. The default profile supplies spacing and visual hierarchy.

## 22.3 Documentation generation

```ts
diagram({
  title: "Order service data model",
  profile: "docs",
  render: "auto",
  save: {
    dir: "docs/diagrams",
    basename: "order-service-data-model",
    formats: ["source", "svg"]
  },
  source: `...`
})
```

Tool result to model: `Saved diagram source and SVG to docs/diagrams/order-service-data-model.{d2,svg}.` The transcript still shows the best local representation, while the model can immediately reference the SVG in the Markdown document it is editing.

## 22.4 Error and correction

```text
First call result:
D2_SYNTAX line 5: unexpected token near "database".

Agent correction:
- Fix missing closing brace.
- Call `diagram` once more with corrected D2.
- If the second render fails, simplify the diagram or explain the limitation.
```

# 23. Future extensions

- Mermaid adapter: accept existing Mermaid source and either render directly or translate supported subsets with explicit lossiness reporting.
- Document regeneration command: scan `docs/diagrams/**/*.d2` and update corresponding SVGs in a deterministic build step.
- Allowlisted icon registry: expose semantic icon names (e.g., `database`, `queue`, `browser`) mapped to bundled trusted assets, never arbitrary URLs.
- Additional profiles: e.g., `incident`, `network`, `dependency`, if real usage shows value.
- Interactive inspection: zoom/pan or full-screen preview using harness-native custom components.
- Diagram IR: only if cross-engine interoperability becomes a hard requirement.
- Alternate renderers: D2-compatible custom SVG renderer or a second DSL backend if D2 reaches a visual/semantic ceiling for a key use case.
- Automated diagram linting: detect overlarge graphs, unlabeled edges, dense crossings, or duplicated labels before render.

# 24. Source references

The implementation proposal is grounded in current public documentation checked on 20 August 2026. References below are intentionally primary/official where available.

- **[D2-EXPORTS]** D2 Exports — SVG, PNG, PDF, PPTX, GIF, ASCII; ASCII beta and character modes. <https://www.d2lang.com/tour/exports/>
- **[D2-CLI]** D2 CLI manual — validate, stdout formats, layout/theme/timeout flags, exit-status guidance. <https://d2lang.com/tour/man/>
- **[D2-THEMES]** D2 Themes — theme selection and dark theme behavior. <https://d2lang.com/tour/themes/>
- **[D2-ELK]** D2 ELK layout — orthogonal routing, containers, crossings, SQL-column routing. <https://d2lang.com/tour/elk/>
- **[D2-TALA]** D2 TALA layout — separate proprietary layout engine and tradeoffs. <https://d2lang.com/tour/tala/>
- **[D2-SQL]** D2 SQL Tables — `shape: sql_table`, field types, constraints. <https://d2lang.com/tour/sql-tables/>
- **[D2-SEQUENCE]** D2 Sequence Diagrams — `shape: sequence_diagram` and normal edge syntax. <https://d2lang.com/tour/sequence-diagrams/>
- **[D2-IMPORTS]** D2 Imports — relative and absolute file imports. <https://d2lang.com/tour/imports/>
- **[D2-ICONS]** D2 Icons — arbitrary URL icons and local image paths. <https://d2lang.com/tour/icons/>
- **[D2-VARS]** D2 Variables/config — CLI/environment precedence over source configuration. <https://d2lang.com/tour/vars/>
- **[PI-EXTENSIONS]** Pi Extensions — custom tools, result details, renderCall/renderResult. <https://pi.dev/docs/latest/extensions>
- **[PI-TUI]** Pi TUI Components — Image component and custom rendering primitives. <https://pi.dev/docs/latest/tui>
- **[PI-USAGE]** Pi Usage — regular/fullscreen TUI image behavior. <https://pi.dev/docs/latest/usage>
- **[OMP-HOME]** OMP — current tool list including `render_mermaid` to ASCII or PNG. <https://omp.sh/>
- **[OMP-DEV]** OMP development guide — tool registry, tool results, extensibility, modes, artifacts. <https://github.com/Raudbjorn/omp/blob/main/packages/coding-agent/DEVELOPMENT.md>

# Appendix A. Ready-to-paste LLM implementation handoff prompt

> **How to use this appendix**
>
> Give the following prompt to an implementation-capable LLM together with the target Pi/OMP repository. It is intentionally prescriptive about architecture and acceptance criteria while allowing the implementer to adapt to the repository’s exact APIs.

```text
You are implementing a terminal-native `diagram` tool for an AI coding harness.

OBJECTIVE
Implement one public tool named `diagram` that lets the model submit D2 diagram source and shows a proper diagram directly in the terminal transcript. The same source must also be usable for persistent documentation artifacts.

PRIMARY DESIGN
1. D2 is the primary agent-facing DSL.
2. Do not ask the LLM to hand-author SVG. D2 deterministically renders SVG/PNG/text.
3. Use one renderer-agnostic tool named `diagram`; do not expose separate public tools per output format.
4. Shared core produces SVG, PNG, or Unicode/ASCII. The harness adapter owns terminal/TUI display. The shared core must never emit Kitty/iTerm escape sequences.
5. Default layout engine is ELK. Visual themes/padding are controlled by renderer profiles, not arbitrary model styling.
6. Persistent documentation defaults to `.d2` source plus `.svg`; `.png` and `.txt` are optional formats.
7. Mermaid is not required for the MVP. Keep the public schema compatible with a future `language: "mermaid"` adapter.
8. Do not introduce a custom Diagram IR in the MVP.

PUBLIC INPUT
Implement an input equivalent to:

type DiagramInput = {
  source: string;
  language?: "d2" | "mermaid"; // default d2; MVP may reject mermaid as not enabled
  title?: string;
  profile?: "explain" | "architecture" | "data" | "docs";
  render?: "auto" | "image" | "unicode" | "ascii" | "source";
  save?: {
    dir?: string;
    basename?: string;
    formats?: Array<"source" | "svg" | "png" | "txt">;
  };
};

MODEL-FACING TOOL DESCRIPTION
“Create and render a diagram from declarative source. Prefer D2. Use this tool when architecture, relationships, sequence, data flow, state transitions, schemas, or process flow are easier to understand visually than as prose. Keep diagrams focused on the user’s question; omit incidental implementation detail. Do not spend tokens on cosmetic styling unless it communicates meaning. The harness applies a consistent visual profile automatically.”

SHARED CORE
Create a harness-agnostic module/package responsible for:
- normalization and input size limits;
- a safe-D2-subset preflight;
- D2 binary discovery/version validation;
- `d2 validate`;
- SVG/PNG/ASCII rendering;
- renderer profiles;
- diagnostics normalization;
- content-addressed caching;
- safe artifact persistence.

SECURITY — REQUIRED, NOT OPTIONAL
Treat model-generated D2 as untrusted. D2 supports file imports and local/remote images/icons. The MVP must:
- reject D2 imports, including relative and absolute imports;
- reject `icon:` values, `shape: image`, arbitrary links, and rich/HTML-like label features unless explicitly allowlisted;
- use a tokenizer/preflight that understands quoted strings/comments rather than only naive regex;
- run D2 in a fresh isolated temporary directory;
- invoke the D2 binary with spawn/execFile argument arrays and `shell: false`;
- use a minimal environment;
- enforce input/output byte caps;
- enforce D2 timeout plus process cancellation;
- fix the layout engine to built-in ELK by policy;
- sanitize/resolve save paths and prevent escaping allowed workspace roots;
- never auto-download executables during a tool call.

D2 PROCESS
Write validated source to a temp `input.d2`. Run `d2 validate input.d2`, checking process exit status. Render with CLI flags that override source-level config. Use `--layout elk`. Render stdout as svg/png/ascii as needed. D2 ASCII is currently beta, so text rendering is best-effort.

REPRESENTATION POLICY
- render=auto + harness can show images => PNG
- render=auto + no images => Unicode D2 ASCII output
- render=unicode => extended Unicode text
- render=ascii => D2 standard ASCII mode
- render=source => source only
If Unicode fails, try standard ASCII once. If that fails, report that text rendering could not represent the diagram and expose the source/graphical artifact in expanded/debug view. Do not fabricate a different graph.

MODEL CONTEXT VS UI
Keep the tool result sent to the LLM compact, e.g. “Rendered ‘Request path’ successfully (image; 8 nodes, 9 edges).” Put paths, diagnostics, source hash, and rendering metadata in tool `details`/structured metadata. Do not feed base64 PNG or a huge ASCII diagram back into the model context.

PI ADAPTER
Use current Pi extension APIs: register a custom tool and custom `renderCall`/`renderResult`. Use Pi’s native Image/Text/Markdown components and Pi’s existing `showImages` / capability state. Do not redetect terminal protocols in the shared core. Respect regular/fullscreen/print behavior. Use expanded view to show source, output paths, and diagnostics.

OMP ADAPTER
Implement the same public `diagram` contract using OMP’s extension/custom-tool/TUI primitives. OMP currently has `render_mermaid`; do not remove it in the MVP. Add `diagram` alongside it, reusing OMP artifact/TUI infrastructure where available. Print/RPC/ACP modes must return text/structured artifact metadata, not image escape sequences.

PROFILES
Implement four renderer-owned profiles:
- explain: compact conversational diagrams;
- architecture: ELK, clear containers, orthogonal routing, more spacing;
- data: table/class-oriented, readable dense layout;
- docs: neutral professional theme, adaptive light/dark SVG where supported.
The LLM should not choose raw D2 theme IDs/layout flags.

PERSISTENCE
When save is requested, default to source + svg. Safe naming: sanitize basename/title; enforce workspace root; use atomic writes. Example:
  docs/diagrams/request-lifecycle.d2
  docs/diagrams/request-lifecycle.svg
Optional png/txt sidecars are supported.

CACHE
Cache by normalized source + language + profile + representation + D2 version + renderer-policy version. Bound cache size and age. Persistent artifacts are distinct from cache entries.

ERRORS
Normalize diagnostics into code/message/line/column/hint where possible. Strip temp paths. Security-policy errors must be explicit. After a rendering error, allow the outer agent to fix D2 and call again; the tool itself must not call an LLM.

TESTS
Add unit, process-integration, visual/golden, terminal-text, harness-integration, and security tests. Fixtures must include:
- basic flow;
- nested architecture;
- sequence;
- ER/sql_table;
- class/object relationships;
- cycles;
- ~20-node architecture;
- Unicode/long labels;
- invalid syntax;
- relative/absolute imports;
- remote icon/local image attempts;
- timeout/oversized input.

ACCEPTANCE CRITERIA
- one `diagram` tool is sufficient for the model;
- D2 source renders to SVG/PNG;
- auto mode uses native harness image rendering when available and Unicode otherwise;
- docs persistence writes `.d2` + `.svg`;
- model result remains compact;
- invalid D2 produces actionable diagnostics;
- imports/assets/links are blocked in the safe subset;
- D2 runs with shell=false, isolated cwd, timeout and output limits;
- Pi and OMP adapters use native TUI primitives;
- no raw terminal image protocol logic exists in diagram-core;
- tests pass and representative diagrams have been manually inspected in both image and text terminals.

IMPLEMENTATION APPROACH
Before editing code, inspect the current repository APIs and the existing OMP `render_mermaid` implementation / Pi tool rendering examples. Adapt names/imports to the repository rather than inventing APIs. Prefer a small, reviewable MVP over building a general diagram framework. Start with D2-only and the fixture set, then integrate the harness UI.

DELIVERABLES
1. shared diagram core;
2. target harness adapter(s);
3. settings/config;
4. tests/fixtures;
5. user docs;
6. short architecture note documenting the safe subset and known D2 ASCII limitations.
```

# Appendix B. Definition of done checklist

- [ ] Public tool is named `diagram` and model schema is intentionally small.
- [ ] D2 is default input; Mermaid is disabled or adapter-based, not a required stage.
- [ ] ELK is forced by renderer policy.
- [ ] Four rendering profiles exist and model cannot choose arbitrary theme IDs.
- [ ] D2 safe-subset tokenizer rejects imports, local/remote assets, links, and disallowed rich content.
- [ ] D2 runs in isolated temp cwd with `shell: false`, minimal environment, timeout, cancellation, and output caps.
- [ ] Validation checks process exit status.
- [ ] SVG, PNG, Unicode, and standard ASCII paths are implemented and tested as applicable.
- [ ] Auto representation uses harness-native image capability, not independent terminal-protocol detection.
- [ ] Pi adapter uses native custom tool rendering and Image/Text components.
- [ ] OMP adapter uses native tool/TUI/artifact primitives and coexists with existing `render_mermaid` for MVP.
- [ ] Model-facing tool result is compact; large render data is not fed back into context.
- [ ] Expanded UI view exposes source, diagnostics, render mode, and artifact paths.
- [ ] Document persistence defaults to `.d2` + `.svg` and enforces workspace path safety.
- [ ] Cache key includes D2 version and renderer-policy version.
- [ ] D2 ASCII limitations are documented and fallback behavior is explicit.
- [ ] Fixture suite covers architecture, sequence, ER, class/object, state/flow, Unicode, long labels, and security cases.
- [ ] Representative PNG/SVG and Unicode outputs have been manually inspected.
- [ ] Print/RPC/ACP/headless modes never emit raw terminal image protocol sequences.
- [ ] User documentation includes concise D2 examples and installation/config guidance for the D2 binary.
> **Final implementation stance**
>
> Start narrow: D2-only, ELK, safe subset, SVG/PNG/Unicode, two thin harness adapters. Prove that the diagrams are genuinely useful and attractive before introducing conversion layers, custom IRs, icon systems, or interactive editors.
