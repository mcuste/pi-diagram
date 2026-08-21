import { execFile } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunCommandOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

/** The command never started, which is what a missing D2 install looks like. */
export class CommandInvocationError extends Error {
  readonly command: string;
  readonly code: string | undefined;

  constructor(command: string, message: string, code: string | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandInvocationError";
    this.command = command;
    this.code = code;
  }
}

export class CommandCancelledError extends Error {
  constructor(command: string) {
    super(`${command} was cancelled.`);
    this.name = "CommandCancelledError";
  }
}

export class CommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${timeoutMs} ms and was stopped.`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/** A `maxBuffer` kill is a size limit, not a broken executable, so it is not a spawn failure. */
export class CommandOutputLimitError extends Error {
  readonly command: string;
  readonly maxOutputBytes: number;

  constructor(command: string, maxOutputBytes: number, options?: ErrorOptions) {
    super(`${command} produced more than ${maxOutputBytes} bytes of output and was stopped.`, {
      ...options,
    });
    this.name = "CommandOutputLimitError";
    this.command = command;
    this.maxOutputBytes = maxOutputBytes;
  }
}

export const runCommand: CommandRunner = (command, args, options) => {
  if (options.signal?.aborted) {
    return Promise.reject(new CommandCancelledError(command));
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? 0;
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  execFile(
    command,
    [...args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      signal: options.signal,
      timeout: timeoutMs,
      env: options.env,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (options.signal?.aborted || error?.name === "AbortError") {
        reject(new CommandCancelledError(command));
        return;
      }

      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new CommandOutputLimitError(command, maxOutputBytes, { cause: error }));
        return;
      }

      // `timeout` kills the child with a signal, which arrives without a numeric exit code.
      if (timeoutMs > 0 && error?.signal && typeof error.code !== "number") {
        reject(new CommandTimeoutError(command, timeoutMs));
        return;
      }

      if (error && typeof error.code !== "number") {
        const detail = error.message.trim();
        reject(
          new CommandInvocationError(
            command,
            `Unable to execute ${command}: ${detail}`,
            typeof error.code === "string" ? error.code : undefined,
            { cause: error },
          ),
        );
        return;
      }

      resolve({
        command,
        args: [...args],
        exitCode: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    },
  );
  return promise;
};
