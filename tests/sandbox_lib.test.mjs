// tools/sandbox-lib.mjs: what a connection holds down stays held until its release is acknowledged (Task 9b fix round 2).
// node --test tests/sandbox_lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cdp } from "../tools/sandbox-lib.mjs";

// A fake socket: replies to everything except the methods/types listed in `silent` (no reply ever comes for those).
const fake = (silent = () => false) => {
  const ws = { sent: [], send(raw) { const msg = JSON.parse(raw); ws.sent.push(msg); if (!silent(msg)) setTimeout(() => ws.onmessage({ data: JSON.stringify({ id: msg.id, result: {} }) }), 1); } };
  return ws;
};

test("a release counts only once it is acknowledged", async () => {
  const c = new Cdp(fake());
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, button: "left" });
  assert.deepEqual(c.heldNow().buttons, ["left"]);
  const up = c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 2, button: "left" });
  assert.deepEqual(c.heldNow().buttons, ["left"], "still held while the release has no reply");
  await up;
  assert.deepEqual(c.heldNow().buttons, [], "released once acknowledged");
});

test("an unacknowledged release stays held, is reported, and releaseAll retries it with a bounded deadline", async () => {
  let answer = false;
  const c = new Cdp(fake((m) => m.params?.type === "mouseReleased" && !answer));
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 6, button: "left" });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 6, button: "left" }, 20).catch(() => {});
  assert.deepEqual(c.heldNow().buttons, ["left"], "a timed-out release leaves the button held");
  answer = true;
  const r = await c.releaseAll(50);
  assert.deepEqual(r.held.buttons, ["left"]);
  assert.equal(r.failed.length, 1, "the failed release is reported");
  assert.deepEqual(r.left.buttons, [], "the retry was acknowledged");
});

test("keys and modifiers come up in releaseAll, the last down first", async () => {
  const c = new Cdp(fake((m) => m.params?.type === "keyUp"));
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft" });
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "l", code: "KeyL" });
  const r = await c.releaseAll(20, 1);
  assert.deepEqual(r.held.keys, ["ControlLeft", "KeyL"]);
  assert.deepEqual(r.left.keys, ["ControlLeft", "KeyL"], "never acknowledged: still held, and said so");
  const ups = c.ws.sent.filter((m) => m.params?.type === "keyUp").map((m) => m.params.code);
  assert.deepEqual(ups, ["KeyL", "ControlLeft"]);
});
