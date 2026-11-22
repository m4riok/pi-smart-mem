import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Pi's loader is not active in this child process. Node's CLI strips types in
// a checkout but refuses to do so inside an installed node_modules package.
const sourceRoot = new URL("./", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot) || !url.endsWith(".ts")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) };
  },
});
if (process.argv[3] === "serve") await import("./embedding-worker.ts");
else {
  // The logging parent must outlive the Pi client that launched it. Otherwise
  // native stdout/stderr pipes would lose their reader while peers still use ONNX.
  const { Diagnostics } = await import("./diagnostics.ts");
  const profile = process.argv[2];
  const log = new Diagnostics(profile, "embedding-worker", (error) => {
    // A failure to write the general log cannot be logged there; leave a
    // single bounded indication in the worker's private directory instead.
    try { writeFileSync(join(profile, "embedding-worker", "diagnostics-error"), String(error).slice(0, 8192), { mode: 0o600 }); }
    catch (failure) { console.error(`Smart Mem worker diagnostics unavailable: ${String(failure)}`); }
  });
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], profile, "serve"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const disconnect = () => { if (child.connected) child.disconnect(); };
  process.once("disconnect", disconnect);
  if (!process.connected) disconnect();
  child.on("message", (message) => { if (process.connected) process.send(message, () => {}); });
  const pump = async (stream, name) => {
    for await (const chunk of stream.setEncoding("utf8")) {
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        await log.write("worker.output", { stream: name, workerPid: child.pid, message: chunk.slice(offset, offset + 4096) });
      }
    }
  };
  void log.write("worker.start", { workerPid: child.pid });
  try {
    const [[code, signal]] = await Promise.all([once(child, "exit"), pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
    await log.write("worker.exit", { workerPid: child.pid, code: code ?? undefined, signal: signal ?? undefined }, code === 0 ? "info" : "error");
    process.exitCode = code ?? 1;
  } catch (error) {
    await log.write("worker.failure", { error: String(error) }, "error");
    if (process.connected) process.send({ error: String(error) }, () => {});
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
