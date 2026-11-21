import type { Diagnostics } from "./diagnostics.ts";
import type { runModel } from "./review.ts";

type ResponseHandler = NonNullable<Parameters<typeof runModel>[4]["onResponse"]>;
export type MaintenanceDiagnostics = Pick<Diagnostics, "debug">;

export function traceDecision(log: MaintenanceDiagnostics | undefined, name: string, fields: Record<string, unknown>, input: unknown) {
  if (!log) return;
  void log.debug(`${name}.request`, { ...fields, input });
  const onResponse: ResponseHandler = ({ content, stopReason, errorMessage }) => {
    void log.debug(`${name}.response`, { ...fields, content, stopReason, errorMessage });
  };
  return { onResponse, result: (result: unknown) => { void log.debug(`${name}.result`, { ...fields, result }); } };
}
