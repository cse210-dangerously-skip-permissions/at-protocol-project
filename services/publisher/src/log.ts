import { log } from "@trustlab/contracts";

/** Write a publisher message or CLI error using the shared service log format. */
export function publisherLog(
  message: unknown,
  writeLine: (line: string) => void = console.log,
): void {
  log(
    "publisher",
    message instanceof Error ? message.message : String(message),
    writeLine,
  );
}
