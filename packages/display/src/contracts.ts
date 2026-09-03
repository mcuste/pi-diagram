import type { StoredPng } from "@mcuste/pi-diagram-core";

export interface Component {
  render(width: number): string[];
}

export interface DisplayTheme {
  fg(color: string, text: string): string;
}

export type DisplayImage = StoredPng;

export interface DiagramCallView {
  /** What is being drawn: the title, or a line count when there is no title. */
  readonly subject: string;
  /** The selected diagram layout and styling profile. */
  readonly profile: string;
  /** The destination directory when the call saves rendered files. */
  readonly saveDirectory: string | undefined;
}

type DisplayRequest = "auto" | "image" | "unicode" | "source";
export type DisplayedAs = "image" | "unicode" | "source";

type DisplayText =
  | { readonly format: "unicode"; readonly content: string }
  | { readonly format: "source"; readonly content: string };

export interface DiagramResultView {
  readonly requested: DisplayRequest;
  readonly display: DisplayText;
  readonly image: DisplayImage | undefined;
  readonly title: string | undefined;
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
