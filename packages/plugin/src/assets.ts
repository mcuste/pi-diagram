import { readFile } from "node:fs/promises";

/**
 * Markdown the extension ships beside its code. The host loads it once at startup, because the
 * tool and the prompt hook both need it without waiting.
 */
export interface TextAsset {
  /** Reads the file on the first call and keeps the result. */
  prime(): Promise<void>;
  /** Throws when `prime` has not finished, so no caller can send an empty prompt. */
  read(): string;
}

export function textAsset(url: URL, what: string): TextAsset {
  let text: string | undefined;
  let loading: Promise<void> | undefined;
  return {
    prime(): Promise<void> {
      loading ??= readFile(url, "utf8").then((source) => {
        text = source.trimEnd();
        if (text === "") {
          throw new Error(`${what} is empty.`);
        }
      });
      return loading;
    },
    read(): string {
      if (text === undefined) {
        throw new Error(`${what} has not loaded.`);
      }
      return text;
    },
  };
}
