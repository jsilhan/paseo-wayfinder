import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { statusRpc, tickRpc, adoptRpc } from "../shared/contracts";

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const status = useRpc(statusRpc);
  const tick = useRpc(tickRpc);
  const adopt = useRpc(adoptRpc);
  const cache = useQueryClient();
  const [issueNumber, setIssueNumber] = useState("");
  const [agentId, setAgentId] = useState("");
  const queryKey = ["wayfinder-status"];
  const query = useQuery({ queryKey, queryFn: () => status({}), refetchInterval: 10_000 });
  const run = useMutation({
    mutationFn: () => tick({}),
    onSuccess: (data) => cache.setQueryData(queryKey, data),
  });
  const adoption = useMutation({
    mutationFn: () => adopt({ issueNumber: Number(issueNumber), agentId: agentId.trim() }),
    onSuccess: (data) => cache.setQueryData(queryKey, data),
  });
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const button = { padding: 12, backgroundColor: theme.colors.accent, borderRadius: 8 };
  const buttonText = { color: theme.colors.accentForeground };
  const error = query.error ?? run.error ?? adoption.error;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <Text style={{ ...text, fontSize: 24 }}>Wayfinder</Text>
      <Text style={muted}>{query.isPending ? "Loading..." :
        `${query.data?.enabled ? "Enabled" : "Paused"} - polls every 5 minutes`}</Text>
      <Text style={muted}>Last reconciliation: {query.data?.lastTick ?? "not yet"}</Text>
      {(error || query.data?.error) && <Text style={{ color: theme.colors.statusDanger }}>
        {error?.message ?? query.data?.error}
      </Text>}
      <Pressable accessibilityRole="button" disabled={run.isPending} style={button}
        onPress={() => run.mutate()}>
        <Text style={buttonText}>{run.isPending ? "Reconciling..." : "Reconcile now (respects pause)"}</Text>
      </Pressable>
      <Text style={muted}>Configure the daemon's wayfinder/config.json to enable dispatch.
        Adoption explicitly binds an already assigned issue to an existing session; it sends no message.
        Re-adopting the same session acknowledges any uncertain update delivery.</Text>
      <TextInput accessibilityLabel="Issue number" placeholder="Issue number"
        placeholderTextColor={theme.colors.foregroundMuted} style={{ ...text, padding: 12 }}
        keyboardType="number-pad" value={issueNumber} onChangeText={setIssueNumber} />
      <TextInput accessibilityLabel="Existing Paseo agent ID" placeholder="Existing Paseo agent ID"
        placeholderTextColor={theme.colors.foregroundMuted} style={{ ...text, padding: 12 }}
        value={agentId} onChangeText={setAgentId} />
      <Pressable accessibilityRole="button" style={button}
        disabled={adoption.isPending || !/^[1-9]\d*$/.test(issueNumber) || !agentId.trim()}
        onPress={() => adoption.mutate()}>
        <Text style={buttonText}>{adoption.isPending ? "Adopting..." : "Confirm adoption / acknowledge update"}</Text>
      </Pressable>
      {query.data?.diagnostics.map((diagnostic, index) =>
        <Text key={`${index}:${diagnostic}`} style={muted}>{diagnostic}</Text>)}
      {query.data?.bindings.map((row) => <View key={row.key} style={{ gap: 4 }}>
        <Text style={text}>{row.repository}#{row.number} - {row.branch}</Text>
        <Text selectable style={muted}>Workspace: {row.workspaceId ?? "not created"}</Text>
        <Text selectable style={muted}>Session: {row.agentId ?? "not created"}</Text>
        <Text style={text}>{row.diagnostic}</Text>
      </View>)}
    </ScrollView>
  );
}
