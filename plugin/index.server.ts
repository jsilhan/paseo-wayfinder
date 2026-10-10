import type { PluginServerContext } from "@getpaseo/plugin/server";
import { statusRpc, tickRpc, adoptRpc } from "./shared/contracts";
import { Runtime } from "./server/runtime";

export default function contribute(server: PluginServerContext) {
  const runtime = new Runtime();
  server.handle(statusRpc, () => runtime.status());
  server.handle(tickRpc, async () => {
    await runtime.run();
    return runtime.status();
  });
  server.handle(adoptRpc, async (input) => {
    await runtime.run(input);
    return runtime.status();
  });
  return () => runtime.stop();
}
