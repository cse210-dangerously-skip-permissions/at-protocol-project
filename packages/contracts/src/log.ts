/** Emit one JSON log line. Standalone services use null when RUN_ID is unset. */
export function log(
  service: string,
  msg: string,
  writeLine: (line: string) => void = (line) =>
    process.stdout.write(line + "\n"),
): void {
  writeLine(
    JSON.stringify({
      ts: new Date().toISOString(),
      service,
      runId: process.env.RUN_ID ?? null,
      msg,
    }),
  );
}
