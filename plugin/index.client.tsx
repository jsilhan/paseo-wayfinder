import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MainSurface } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MainSurface);
  client.addSidebarItem({ id: "wayfinder", title: "Wayfinder", icon: "Compass", surface: "main" });
  return () => {};
}
