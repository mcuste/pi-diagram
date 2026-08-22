import { DOMParser, type Element, XMLSerializer } from "@xmldom/xmldom";

const MAX_SVG_BYTES = 1024 * 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SAFE_ELEMENTS: Readonly<Record<string, true>> = {
  defs: true,
  g: true,
  marker: true,
  mask: true,
  path: true,
  pattern: true,
  polygon: true,
  rect: true,
  style: true,
  svg: true,
  text: true,
};
const SAFE_AT_RULES: Readonly<Record<string, true>> = { "font-face": true, media: true };
const UNSAFE_CSS_IDENTIFIERS: Readonly<Record<string, true>> = {
  behavior: true,
  expression: true,
  javascript: true,
  "-moz-binding": true,
};
const LOCAL_REFERENCE = /^url\(\s*#[A-Za-z_][-A-Za-z0-9_.:]*\s*\)$/iu;
const EMBEDDED_FONT = /^data:application\/font-woff;base64,[A-Za-z0-9+/=]+$/u;

export class SvgOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgOutputError";
  }
}

/** Parses SVG as XML before allowing it to become an image or a workspace artifact. */
export function parseSafeSvg(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") > MAX_SVG_BYTES) {
    throw new SvgOutputError("D2 produced an SVG larger than the output limit.");
  }
  const svg = raw.trim();
  if (svg.length === 0) {
    throw new SvgOutputError("D2 produced an empty SVG.");
  }

  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    document = new DOMParser({
      locator: false,
      onError: () => {
        throw new SvgOutputError("D2 returned malformed SVG.");
      },
    }).parseFromString(svg, "image/svg+xml");
  } catch (error) {
    if (error instanceof SvgOutputError) {
      throw error;
    }
    throw new SvgOutputError("D2 returned malformed SVG.");
  }

  if (document.doctype !== null || document.documentElement === null) {
    throw new SvgOutputError("D2 output is not an SVG document without declarations.");
  }
  for (let child = document.firstChild; child !== null; child = child.nextSibling) {
    const xmlDeclaration =
      child.nodeType === child.PROCESSING_INSTRUCTION_NODE &&
      child.nodeName.toLowerCase() === "xml";
    if (
      child.nodeType !== child.ELEMENT_NODE &&
      !xmlDeclaration &&
      !isWhitespace(child.nodeValue ?? "")
    ) {
      throw new SvgOutputError("D2 SVG contains a non-element document node.");
    }
  }

  parseElement(document.documentElement);

  try {
    return new XMLSerializer().serializeToString(document).trim();
  } catch {
    throw new SvgOutputError("D2 returned malformed SVG.");
  }
}

function parseElement(element: Element): void {
  const name = element.tagName.toLowerCase();
  if (
    !SAFE_ELEMENTS[name] ||
    (name === "svg" && element.namespaceURI !== SVG_NAMESPACE) ||
    (name !== "svg" && element.namespaceURI !== null && element.namespaceURI !== SVG_NAMESPACE)
  ) {
    throw new SvgOutputError(`D2 SVG contains unsupported element <${element.tagName}>.`);
  }

  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute !== null) {
      parseAttribute(attribute.name, attribute.value);
    }
  }

  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === child.ELEMENT_NODE) {
      parseElement(child as Element);
      continue;
    }
    if (child.nodeType === child.TEXT_NODE || child.nodeType === child.CDATA_SECTION_NODE) {
      if (name === "style") {
        parseStylesheet(child.nodeValue ?? "");
        continue;
      }
      if (child.nodeType === child.TEXT_NODE) {
        continue;
      }
    }
    throw new SvgOutputError(`D2 SVG contains unsupported node type ${child.nodeType}.`);
  }
}

function parseAttribute(name: string, value: string): void {
  const normalized = name.toLowerCase();
  if (
    normalized.startsWith("on") ||
    ["action", "data", "href", "src", "xlink:href"].includes(normalized)
  ) {
    throw new SvgOutputError(`D2 SVG contains unsafe attribute ${name}.`);
  }
  if (normalized === "style") {
    parseStylesheet(value);
  }
  if (/url\s*\(/iu.test(value) && !LOCAL_REFERENCE.test(value)) {
    throw new SvgOutputError(
      `D2 SVG attribute ${name} references something other than a local element.`,
    );
  }
}

/** Rejects CSS that can load resources or invoke browser-specific behavior. */
function parseStylesheet(css: string): void {
  let index = 0;
  while (index < css.length) {
    const character = css[index] as string;
    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) {
        throw new SvgOutputError("D2 SVG contains an unterminated CSS comment.");
      }
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      index = skipCssString(css, index).next;
      continue;
    }
    if (character === "@") {
      const token = readCssIdentifier(css, index + 1);
      if (token === undefined || !SAFE_AT_RULES[token.value]) {
        throw new SvgOutputError("D2 SVG contains an unsupported CSS rule.");
      }
      index = token.next;
      continue;
    }
    const token = readCssIdentifier(css, index);
    if (token === undefined) {
      index += 1;
      continue;
    }
    if (UNSAFE_CSS_IDENTIFIERS[token.value]) {
      throw new SvgOutputError(`D2 SVG contains unsafe CSS identifier ${token.value}.`);
    }
    let next = token.next;
    while (isWhitespace(css[next] ?? "")) {
      next += 1;
    }
    if (css[next] === "(" && token.value === "url") {
      index = parseCssUrl(css, next + 1);
      continue;
    }
    index = token.next;
  }
}

function parseCssUrl(css: string, start: number): number {
  let index = start;
  while (isWhitespace(css[index] ?? "")) {
    index += 1;
  }

  let value: string;
  if (css[index] === '"' || css[index] === "'") {
    const string = skipCssString(css, index);
    value = string.value;
    index = string.next;
  } else {
    const beginning = index;
    while (index < css.length && css[index] !== ")") {
      if (isWhitespace(css[index] as string) || css[index] === "(") {
        throw new SvgOutputError("D2 SVG contains an invalid CSS URL.");
      }
      index += 1;
    }
    value = css.slice(beginning, index);
  }
  while (isWhitespace(css[index] ?? "")) {
    index += 1;
  }
  if (css[index] !== ")" || (!EMBEDDED_FONT.test(value) && !value.startsWith("#"))) {
    throw new SvgOutputError("D2 SVG contains an external CSS URL.");
  }
  return index + 1;
}

function readCssIdentifier(
  css: string,
  start: number,
): { readonly value: string; readonly next: number } | undefined {
  let index = start;
  let value = "";
  while (index < css.length) {
    const character = css[index] as string;
    if (/[A-Za-z0-9_-]/u.test(character)) {
      value += character;
      index += 1;
      continue;
    }
    if (character !== "\\") {
      break;
    }
    const escaped = readCssEscape(css, index + 1);
    value += escaped.value;
    index = escaped.next;
  }
  return value.length === 0 ? undefined : { value: value.toLowerCase(), next: index };
}

function skipCssString(
  css: string,
  start: number,
): { readonly value: string; readonly next: number } {
  const quote = css[start] as string;
  let index = start + 1;
  let value = "";
  while (index < css.length) {
    const character = css[index] as string;
    if (character === quote) {
      return { value, next: index + 1 };
    }
    if (character === "\\") {
      const escaped = readCssEscape(css, index + 1);
      value += escaped.value;
      index = escaped.next;
      continue;
    }
    value += character;
    index += 1;
  }
  throw new SvgOutputError("D2 SVG contains an unterminated CSS string.");
}

function readCssEscape(
  css: string,
  start: number,
): { readonly value: string; readonly next: number } {
  const hex = /^[0-9A-Fa-f]{1,6}/u.exec(css.slice(start))?.[0];
  if (hex === undefined) {
    const value = css[start];
    if (value === undefined) {
      throw new SvgOutputError("D2 SVG contains an incomplete CSS escape.");
    }
    return { value, next: start + 1 };
  }
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint === 0 || codePoint > 0x10ffff) {
    throw new SvgOutputError("D2 SVG contains an invalid CSS escape.");
  }
  let next = start + hex.length;
  if (isWhitespace(css[next] ?? "")) {
    next += 1;
  }
  return { value: String.fromCodePoint(codePoint), next };
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}
