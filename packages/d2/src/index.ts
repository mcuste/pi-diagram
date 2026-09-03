export { parseD2Diagnostics } from "./diagnostics.js";
export type { EmbeddedFont } from "./fonts.js";
export { missingCodePoints, parseEmbeddedFonts, textCodePoints } from "./fonts.js";
export { inspect } from "./preflight.js";
export type { LayoutPolicy, ProfileName, RenderProfile } from "./profiles.js";
export { DEFAULT_PROFILE, PROFILE_NAMES, parseProfile } from "./profiles.js";
export type { RasterRequest, SvgRasterizer } from "./raster.js";
export {
  parseCachedImage,
  parseTargetDimensions,
  parseTargetWidth,
  ResvgRasterizer,
} from "./raster.js";
export type { DiagramRendering, Representation } from "./render.js";
export { parseRepresentation, renderDiagram } from "./render.js";
export type {
  AsciiMode,
  D2FormatRequest,
  D2Renderer,
  D2Svg,
  D2SvgRequest,
  D2Text,
  D2TextRequest,
  RenderedDiagramText,
  RenderedSvg,
  SupportedD2Version,
} from "./runner.js";
export {
  D2Cli,
  parseBinaryName,
  parseD2Version,
  parseRenderedSvg,
  parseRenderedText,
  SourceFormatUnavailableError,
  SvgRenderUnavailableError,
  TextRenderUnavailableError,
} from "./runner.js";
export type { D2Source, ParsedD2Source, SafeTitle } from "./source.js";
export { parseD2Source, parseTitle } from "./source.js";
