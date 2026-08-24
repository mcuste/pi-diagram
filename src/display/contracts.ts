export interface Component {
  render(width: number): string[];
}

export interface DisplayTheme {
  fg(color: string, text: string): string;
}

export interface DisplayImage {
  readonly path: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface DiagramCallView {
  /** What is being drawn: the title, or a line count when there is no title. */
  readonly subject: string;
  /** The profile, and the directory when the call also saves files. */
  readonly note: string;
}

type DisplayRequest = "auto" | "image" | "unicode" | "source";
export type DisplayedAs = "image" | "unicode" | "source";

export interface DiagramResultView {
  readonly requested: DisplayRequest;
  readonly renderedAs: "unicode" | "source";
  readonly image: DisplayImage | undefined;
  readonly title: string | undefined;
  readonly text: string;
  readonly notes: readonly string[];
  readonly details: (displayedAs: DisplayedAs) => readonly string[];
}

export interface RenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

export interface DiagramDisplay<TContext> {
  resolveContext(key: object, options: RenderOptions, rawContext: unknown): TContext;
  renderCall(view: DiagramCallView, theme: DisplayTheme): Component;
  renderResult(
    view: DiagramResultView,
    options: RenderOptions,
    theme: DisplayTheme,
    context: TContext,
  ): Component;
}
