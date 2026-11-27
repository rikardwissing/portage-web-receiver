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

function lookup(code: string, address = "203.0.113.7"): Promise<Response> {
  return exports.default.fetch(new Request(`https://signal.test/watch/code/${encodeURIComponent(code)}`, {
    headers: { "CF-Connecting-IP": address },
  }));
}

async function codeFor(socket: WebSocket): Promise<string> {
  socket.send(JSON.stringify({ type: "code" }));
  const reply = await nextMessage(socket);
  expect(reply).toMatchObject({ type: "code" });
  return reply.code as string;
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

  it("gives a room one short code that finds it while it is open", async () => {
    const host = await openMember("coded-room", "member-host");
    const code = await codeFor(host.socket);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(await codeFor(host.socket)).toBe(code);

    const found = await lookup(`${code.slice(0, 3).toLowerCase()} ${code.slice(3)}`, "203.0.113.10");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ room: "coded-room" });

    host.socket.close(1000, "done");
    await settle();
    const gone = await lookup(code, "203.0.113.10");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: "no_room" });
  });

  it("passes a knock to everyone and a let-in only to the knocker", async () => {
    const host = await openMember("knock-room", "member-host");
    const friend = await openMember("knock-room", "member-friend");
    await nextMessage(host.socket);
    const guest = await openMember("knock-room", "member-guest");
    await nextMessage(host.socket);
    await nextMessage(friend.socket);

    const key = "a".repeat(43);
    guest.socket.send(JSON.stringify({ type: "knock", key }));
    expect(await nextMessage(host.socket)).toEqual({ type: "knock", from: "member-guest", key });
    expect(await nextMessage(friend.socket)).toEqual({ type: "knock", from: "member-guest", key });

    host.socket.send(JSON.stringify({ type: "letin", to: "member-guest", data: "sealed-key" }));
    expect(await nextMessage(guest.socket)).toEqual({ type: "letin", from: "member-host", data: "sealed-key" });
    friend.socket.send(JSON.stringify({ type: "ping", id: 1 }));
    expect(await nextMessage(friend.socket)).toMatchObject({ type: "pong", id: 1 });

    guest.socket.send(JSON.stringify({ type: "knock", key: "short" }));
    expect(await nextMessage(guest.socket)).toMatchObject({ type: "error", code: "invalid_message" });
    for (const member of [host, friend, guest]) member.socket.close(1000, "done");
  });

  it("lets only the longest-present member end the room, and then turns everyone away", async () => {
    const host = await openMember("ending-room", "member-host");
    const code = await codeFor(host.socket);
    const guest = await openMember("ending-room", "member-guest");
    await nextMessage(host.socket);

    guest.socket.send(JSON.stringify({ type: "end" }));
    guest.socket.send(JSON.stringify({ type: "ping", id: 2 }));
    expect(await nextMessage(guest.socket)).toMatchObject({ type: "pong", id: 2 });

    host.socket.send(JSON.stringify({ type: "end" }));
    expect(await nextMessage(guest.socket)).toEqual({ type: "ended", by: "member-host" });
    expect(await nextMessage(host.socket)).toEqual({ type: "ended", by: "member-host" });

    const late = await join("ending-room", "member-late");
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ error: "ended" });
    const lookedUp = await lookup(code, "203.0.113.11");
    expect(lookedUp.status).toBe(404);
    await lookedUp.text();
  });

  it("moves the code with the room when the host re-keys", async () => {
    const host = await openMember("old-room", "member-host");
    const code = await codeFor(host.socket);
    const guest = await openMember("old-room", "member-guest");
    await nextMessage(host.socket);

    guest.socket.send(JSON.stringify({ type: "moveCode", to: "guest-room" }));
    await settle();
    expect(await (await lookup(code, "203.0.113.12")).json()).toEqual({ room: "old-room" });

    host.socket.send(JSON.stringify({ type: "moveCode", to: "new-room" }));
    await settle();
    host.socket.close(1000, "moving");
    guest.socket.close(1000, "moving");
    await settle();
    expect(await (await lookup(code, "203.0.113.12")).json()).toEqual({ room: "new-room" });

    const moved = await openMember("new-room", "member-host");
    expect(await codeFor(moved.socket)).toBe(code);
    moved.socket.close(1000, "done");
  });

  it("slows down an address that keeps missing codes", async () => {
    for (let index = 0; index < 10; index++) {
      const miss = await lookup("ZZZZZZ", "198.51.100.20");
      expect(miss.status).toBe(404);
      await miss.text();
    }
    const blocked = await lookup("ZZZZZZ", "198.51.100.20");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ error: "slow_down" });

    const neighbour = await lookup("ZZZZZZ", "198.51.100.21");
    expect(neighbour.status).toBe(404);
    await neighbour.text();

    for (let index = 0; index < 10; index++) {
      await (await lookup("ZZZZZZ", `2001:db8:1:2:${index}::1`)).text();
    }
    const sameNetwork = await lookup("ZZZZZZ", "2001:db8:1:2:ffff::9");
    expect(sameNetwork.status).toBe(429);
    await sameNetwork.text();

    const invalid = await lookup("O0I1L!", "198.51.100.22");
    expect(invalid.status).toBe(400);
    await invalid.text();
  });
});
