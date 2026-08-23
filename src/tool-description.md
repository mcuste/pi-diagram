Draw a D2 diagram in the terminal. Use it when connected parts, order, data, or state are clearer as a picture than prose. Include only what answers the question.

## Selection

- `c4`: users, external systems, separately running programs or services, or major modules
- `architecture`: runtime services and infrastructure without C4 levels
- `data`: database records and relations with `sql_table`, or code types and APIs with `class`
- `dependency`: imports, packages, build order, affected code, or cycles
- `tree`: folders, call trees, or other parent-child structures
- `explain`: states, decisions, transformations, or process flow; default
- `docs`: a saved diagram only when no profile above fits

Use `sequence_diagram` for requests, calls, events, callbacks, or jobs in time order.

For C4, use one level: context for users and external systems, container for separately running programs or services, or component for major modules inside one container.

If several views fit, choose the one that answers the main question. Split separate views.

## Syntax

- Edge: `client -> gateway: request`
- Container: `core: Core Services { api; worker }`, then `core.api -> core.worker`
- Sequence: `flow: { shape: sequence_diagram; user -> api: submit }`
- Class: `Repository: { shape: class; find(id): Order }`
- Table: `users: { shape: sql_table; id: int {constraint: primary_key} }`
- C4 person: `customer: Customer { shape: c4-person }; customer -> system: uses`

Do not use `@` imports, `icon`, `link`, `shape: image`, or `|...|` labels. Do not set colors, themes, or fonts.

Use 5 to 15 nodes. The `dependency` profile can use up to 25. Split larger diagrams.

Use `save` only when the user asks to keep the diagram.

Leave `render` and `formats` unset unless the user asks for another method. The default shows Unicode, opens a PNG with Ctrl+O, and saves editable D2 plus SVG. Embed or copy the SVG into documents.
