import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { WatchRoom } from "../src/watch-room";

type Message = Record<string, unknown>;
const queues = new WeakMap<WebSocket, Message[]>();
const waiters = new WeakMap<WebSocket, Array<(message: Message) => void>>();

function track(socket: WebSocket): void {
  queues.set(socket, []);
  waiters.set(socket, []);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    const waiter = waiters.get(socket)?.shift();
    if (waiter) waiter(message);
    else queues.get(socket)?.push(message);
  });
}

function nextMessage(socket: WebSocket): Promise<Message> {
  const queued = queues.get(socket)?.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    waiters.get(socket)?.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function join(room: string, member: string): Promise<Response> {
  return exports.default.fetch(new Request(
    `https://signal.test/watch/ws/${room}?member=${member}`,
    { headers: { Upgrade: "websocket" } },
  ));
}

async function openMember(room: string, member: string) {
  const response = await join(room, member);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  track(socket);
  const welcome = nextMessage(socket);
  socket.accept();
  const hello = await welcome;
  expect(hello).toMatchObject({ type: "welcome", protocol: 1, member });
  return { socket, welcome: hello };
}

function roomStub(room: string) {
  const rooms = (env as unknown as { WATCH_ROOMS: DurableObjectNamespace<WatchRoom> }).WATCH_ROOMS;
  return rooms.getByName(`watch:${room}`);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("watch room", () => {
  it("welcomes members with who is already there and announces joins", async () => {
    const a = await openMember("film-night", "member-aaaa");
    expect(a.welcome.members).toEqual([]);
    expect(typeof a.welcome.at).toBe("number");

    const b = await openMember("film-night", "member-bbbb");
    expect(b.welcome.members).toEqual(["member-aaaa"]);
    expect(await nextMessage(a.socket)).toEqual({ type: "joined", member: "member-bbbb" });

    a.socket.close(1000, "done");
    b.socket.close(1000, "done");
  });

  it("relays opaque messages to everyone else, untouched and stamped", async () => {
    const a = await openMember("relay-room", "member-aaaa");
    const b = await openMember("relay-room", "member-bbbb");
    const c = await openMember("relay-room", "member-cccc");
    await nextMessage(a.socket);
    await nextMessage(a.socket);
    await nextMessage(b.socket);

    const ciphertext = "q83vEjRWeJA+/w==";
    const before = Date.now();
    a.socket.send(JSON.stringify({ type: "send", data: ciphertext }));
    for (const peer of [b.socket, c.socket]) {
      const relayed = await nextMessage(peer);
      expect(relayed).toMatchObject({ type: "message", from: "member-aaaa", data: ciphertext });
      expect(relayed.at as number).toBeGreaterThanOrEqual(before - 1000);
    }

    a.socket.send(JSON.stringify({ type: "ping", id: 7 }));
    const pong = await nextMessage(a.socket);
    expect(pong).toMatchObject({ type: "pong", id: 7 });
    expect(typeof pong.at).toBe("number");

    for (const member of [a, b, c]) member.socket.close(1000, "done");
  });

  it("rejects bad requests and oversized messages", async () => {
    const noUpgrade = await exports.default.fetch("https://signal.test/watch/ws/some-room?member=member-aaaa");
    expect(noUpgrade.status).toBe(426);
    await noUpgrade.text();

    const badRoom = await join("bad.room", "member-aaaa");
    expect(badRoom.status).toBe(400);
    await badRoom.text();

    const badMember = await join("ok-room", "x");
    expect(badMember.status).toBe(400);
    expect(await badMember.json()).toMatchObject({ error: "invalid_member" });

    const a = await openMember("limits-room", "member-aaaa");
    a.socket.send(JSON.stringify({ type: "shout" }));
    expect(await nextMessage(a.socket)).toMatchObject({ type: "error", code: "invalid_message" });
    a.socket.send(JSON.stringify({ type: "send", data: "x".repeat(17_000) }));
    expect(await nextMessage(a.socket)).toMatchObject({ type: "error", code: "message_too_large" });
  });

  it("replaces a reconnecting member instead of counting it twice", async () => {
    const a = await openMember("rejoin-room", "member-aaaa");
    await openMember("rejoin-room", "member-bbbb");
    await nextMessage(a.socket);

    const again = await openMember("rejoin-room", "member-bbbb");
    expect(again.welcome.members).toEqual(["member-aaaa"]);
    expect(await nextMessage(a.socket)).toEqual({ type: "joined", member: "member-bbbb" });
    expect(await roomStub("rejoin-room").memberCount()).toBe(2);

    a.socket.send(JSON.stringify({ type: "send", data: "hello" }));
    expect(await nextMessage(again.socket)).toMatchObject({ type: "message", data: "hello" });
    a.socket.close(1000, "done");
    again.socket.close(1000, "done");
  });

  it("announces leaving and forgets everyone when the room empties", async () => {
    const a = await openMember("empty-room", "member-aaaa");
    const b = await openMember("empty-room", "member-bbbb");
    await nextMessage(a.socket);

    b.socket.close(1000, "bye");
    expect(await nextMessage(a.socket)).toEqual({ type: "left", member: "member-bbbb" });
    a.socket.close(1000, "bye");
    await settle();
    expect(await roomStub("empty-room").memberCount()).toBe(0);

    const c = await openMember("empty-room", "member-cccc");
    expect(c.welcome.members).toEqual([]);
    c.socket.close(1000, "done");
  });

  it("turns people away when the room is full", async () => {
    const members = [];
    for (let index = 0; index < 12; index++) {
      members.push(await openMember("full-room", `member-${String(index).padStart(4, "0")}`));
    }
    const late = await join("full-room", "member-late");
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "room_full" });
    for (const member of members) member.socket.close(1000, "done");
  });
});
