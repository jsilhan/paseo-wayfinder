import { test } from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { createPaseoClient } from "@getpaseo/client";

test("SDK construction and disposal never open a network connection", async (t) => {
  const connect = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Network access is forbidden in this unit test");
  });
  const client = createPaseoClient({ url: "ws://paseo.test.invalid/ws", reconnect: { enabled: false } });
  assert.equal(client.getConnectionState().status, "idle");
  await client.close();
  assert.equal(client.getConnectionState().status, "disposed");
  assert.equal(connect.mock.callCount(), 0);
});
