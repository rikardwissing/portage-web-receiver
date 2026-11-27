import { DurableObject } from "cloudflare:workers";

export const WATCH_MEMBER_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const WATCH_ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WATCH_MESSAGE_LIMIT = 16_384;
export const WATCH_ROOM_CAPACITY = 12;
export const WATCH_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const WATCH_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
export const WATCH_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const WATCH_CODE_MOVE_GRACE_MS = 30_000;
export const WATCH_ENDED_KEEP_MS = 6 * 60 * 60 * 1000;
export const WATCH_CODE_MISS_LIMITS = [
  { windowMs: 10 * 60 * 1000, max: 10 },
  { windowMs: 24 * 60 * 60 * 1000, max: 30 },
];

export interface WatchEnv {
  WATCH_ROOMS: DurableObjectNamespace<WatchRoom>;
  WATCH_CODES: DurableObjectNamespace<WatchCode>;
  WATCH_GATES: DurableObjectNamespace<WatchGate>;
}

interface MemberAttachment {
  member: string;
  room?: string;
  since?: number;
  replaced?: boolean;
}

type WatchClientMessage =
  | { type: "ping"; id: number }
  | { type: "send"; data: string }
  | { type: "code" }
  | { type: "knock"; key: string }
  | { type: "letin"; to: string; data: string }
  | { type: "moveCode"; to: string }
  | { type: "end" };

export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "");
}

export function randomCode(): string {
  let code = "";
  while (code.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      if (byte < 240 && code.length < 6) code += WATCH_CODE_ALPHABET[byte % 30];
    }
  }
  return code;
}

function errorJSON(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export class WatchRoom extends DurableObject<WatchEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const member = url.searchParams.get("member");
    if (!member || !WATCH_MEMBER_RE.test(member)) {
      return errorJSON("invalid_member", "member is required", 400);
    }
    const room = url.pathname.split("/").pop() ?? "";
    if (await this.ctx.storage.get<boolean>("ended")) {
      return errorJSON("ended", "This Watch Together has ended", 410);
    }

    const others = this.members().filter((socket) => this.attachment(socket)?.member !== member);
    if (others.length >= WATCH_ROOM_CAPACITY) return errorJSON("room_full", "This room is full", 409);
    for (const socket of this.ctx.getWebSockets(member)) {
      socket.serializeAttachment({ member, replaced: true } satisfies MemberAttachment);
      socket.close(4000, "replaced");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.serializeAttachment({ member, room, since: Date.now() } satisfies MemberAttachment);
    this.ctx.acceptWebSocket(server, [member]);
    this.send(server, {
      type: "welcome",
      protocol: 1,
      member,
      members: others.map((socket) => this.attachment(socket)!.member),
      at: Date.now(),
    });
    for (const socket of others) this.send(socket, { type: "joined", member });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async memberCount(): Promise<number> {
    return this.members().length;
  }

  async isOpen(): Promise<boolean> {
    if (await this.ctx.storage.get<boolean>("ended")) return false;
    if (this.members().length > 0) return true;
    const grace = await this.ctx.storage.get<number>("codeGrace");
    return grace !== undefined && grace > Date.now();
  }

  async adoptCode(code: string): Promise<void> {
    await this.ctx.storage.put({ code, codeGrace: Date.now() + WATCH_CODE_MOVE_GRACE_MS });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const at = Date.now();
    const sender = this.attachment(socket);
    if (!sender || sender.replaced) return;
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > WATCH_MESSAGE_LIMIT) {
      this.send(socket, { type: "error", code: "message_too_large", message: "Messages must be text under 16 KB" });
      socket.close(1009, "message too large");
      return;
    }

    let parsed: WatchClientMessage;
    try {
      parsed = JSON.parse(message) as WatchClientMessage;
    } catch {
      return this.send(socket, { type: "error", code: "invalid_json", message: "Invalid JSON" });
    }

    if (parsed.type === "ping" && Number.isSafeInteger(parsed.id)) {
      return this.send(socket, { type: "pong", id: parsed.id, at });
    }
    if (parsed.type === "send" && typeof parsed.data === "string" && parsed.data.length > 0) {
      const relayed = JSON.stringify({ type: "message", from: sender.member, data: parsed.data, at });
      for (const other of this.members()) {
        if (other !== socket) this.sendText(other, relayed);
      }
      return;
    }
    if (parsed.type === "code") {
      const code = await this.ensureCode(sender.room);
      if (code) return this.send(socket, { type: "code", code });
      return this.send(socket, { type: "error", code: "code_unavailable", message: "No code right now" });
    }
    if (parsed.type === "knock" && typeof parsed.key === "string" && WATCH_KEY_RE.test(parsed.key)) {
      const relayed = JSON.stringify({ type: "knock", from: sender.member, key: parsed.key });
      for (const other of this.members()) {
        if (other !== socket) this.sendText(other, relayed);
      }
      return;
    }
    if (parsed.type === "letin" && typeof parsed.to === "string" && WATCH_MEMBER_RE.test(parsed.to)
        && typeof parsed.data === "string" && parsed.data.length > 0) {
      const relayed = JSON.stringify({ type: "letin", from: sender.member, data: parsed.data });
      for (const other of this.ctx.getWebSockets(parsed.to)) {
        if (this.isMember(other)) this.sendText(other, relayed);
      }
      return;
    }
    if (parsed.type === "moveCode" && typeof parsed.to === "string" && WATCH_ROOM_RE.test(parsed.to)) {
      if (!this.isOldest(socket) || !sender.room || parsed.to === sender.room) return;
      const code = await this.ctx.storage.get<string>("code");
      if (!code) return;
      await this.env.WATCH_ROOMS.getByName(`watch:${parsed.to}`).adoptCode(code);
      if (await this.env.WATCH_CODES.getByName(`code:${code}`).move(sender.room, parsed.to)) {
        await this.ctx.storage.delete(["code", "codeGrace"]);
      }
      return;
    }
    if (parsed.type === "end") {
      if (!this.isOldest(socket)) return;
      return this.end(sender);
    }
    this.send(socket, { type: "error", code: "invalid_message", message: "Unknown message" });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.leave(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.leave(socket);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async ensureCode(room: string | undefined): Promise<string | null> {
    if (!room) return null;
    let found: string | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      const held = await this.ctx.storage.get<string>("code");
      if (held) {
        found = held;
        return;
      }
      for (let tries = 0; tries < 12 && !found; tries++) {
        const code = randomCode();
        if (await this.env.WATCH_CODES.getByName(`code:${code}`).claim(room)) {
          await this.ctx.storage.put("code", code);
          found = code;
        }
      }
    });
    return found;
  }

  private async end(by: MemberAttachment): Promise<void> {
    await this.ctx.storage.put("ended", true);
    await this.ctx.storage.setAlarm(Date.now() + WATCH_ENDED_KEEP_MS);
    await this.releaseCode(by.room);
    const notice = JSON.stringify({ type: "ended", by: by.member });
    for (const socket of this.members()) {
      const attachment = this.attachment(socket)!;
      this.sendText(socket, notice);
      socket.serializeAttachment({ ...attachment, replaced: true } satisfies MemberAttachment);
      try { socket.close(4001, "ended"); } catch {}
    }
  }

  private async releaseCode(room: string | undefined): Promise<void> {
    const code = await this.ctx.storage.get<string>("code");
    if (!code) return;
    await this.ctx.storage.delete(["code", "codeGrace"]);
    if (room) await this.env.WATCH_CODES.getByName(`code:${code}`).release(room);
  }

  private async leave(socket: WebSocket): Promise<void> {
    const gone = this.attachment(socket);
    try { socket.close(1000, "left"); } catch { /* already closed */ }
    if (!gone || gone.replaced) return;
    gone.replaced = true;
    socket.serializeAttachment(gone);
    const left = this.members();
    for (const other of left) this.send(other, { type: "left", member: gone.member });
    if (left.length === 0) {
      const grace = await this.ctx.storage.get<number>("codeGrace");
      if (grace === undefined || grace <= Date.now()) await this.releaseCode(gone.room);
    }
  }

  private isOldest(socket: WebSocket): boolean {
    const mine = this.attachment(socket)?.since ?? Infinity;
    return this.members().every((other) => other === socket || (this.attachment(other)?.since ?? Infinity) >= mine);
  }

  private isMember(socket: WebSocket): boolean {
    const attachment = this.attachment(socket);
    return attachment !== null && !attachment.replaced && socket.readyState === WebSocket.OPEN;
  }

  private members(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => this.isMember(socket));
  }

  private attachment(socket: WebSocket): MemberAttachment | null {
    return socket.deserializeAttachment() as MemberAttachment | null;
  }

  private send(socket: WebSocket, value: unknown): void {
    this.sendText(socket, JSON.stringify(value));
  }

  private sendText(socket: WebSocket, text: string): void {
    try { socket.send(text); } catch { /* closed between lookup and send */ }
  }
}

export class WatchCode extends DurableObject<WatchEnv> {
  async claim(room: string): Promise<boolean> {
    let claimed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const held = await this.ctx.storage.get<string>("room");
      if (held && held !== room && await this.roomOpen(held)) return;
      await this.ctx.storage.put("room", room);
      claimed = true;
    });
    return claimed;
  }

  async lookup(): Promise<string | null> {
    const held = await this.ctx.storage.get<string>("room");
    if (!held) return null;
    if (await this.roomOpen(held)) return held;
    await this.ctx.storage.deleteAll();
    return null;
  }

  async move(from: string, to: string): Promise<boolean> {
    const held = await this.ctx.storage.get<string>("room");
    if (held !== from) return false;
    await this.ctx.storage.put("room", to);
    return true;
  }

  async release(room: string): Promise<void> {
    if (await this.ctx.storage.get<string>("room") === room) await this.ctx.storage.deleteAll();
  }

  private roomOpen(room: string): Promise<boolean> {
    return this.env.WATCH_ROOMS.getByName(`watch:${room}`).isOpen();
  }
}

export class WatchGate extends DurableObject<WatchEnv> {
  async retryAfter(now = Date.now()): Promise<number> {
    const misses = await this.recent(now);
    let wait = 0;
    for (const limit of WATCH_CODE_MISS_LIMITS) {
      const inWindow = misses.filter((at) => now - at < limit.windowMs);
      if (inWindow.length >= limit.max) {
        const freesAt = inWindow[inWindow.length - limit.max] + limit.windowMs;
        wait = Math.max(wait, Math.ceil((freesAt - now) / 1000));
      }
    }
    return wait;
  }

  async miss(now = Date.now()): Promise<void> {
    const misses = [...await this.recent(now), now];
    await this.ctx.storage.put("misses", misses);
    await this.ctx.storage.setAlarm(now + WATCH_CODE_MISS_LIMITS[WATCH_CODE_MISS_LIMITS.length - 1].windowMs);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async recent(now: number): Promise<number[]> {
    const longest = Math.max(...WATCH_CODE_MISS_LIMITS.map((limit) => limit.windowMs));
    const misses = await this.ctx.storage.get<number[]>("misses") ?? [];
    return misses.filter((at) => now - at < longest).sort((a, b) => a - b);
  }
}
