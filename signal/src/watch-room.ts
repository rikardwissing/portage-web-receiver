import { DurableObject } from "cloudflare:workers";

export const WATCH_MEMBER_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const WATCH_MESSAGE_LIMIT = 16_384;
export const WATCH_ROOM_CAPACITY = 12;

interface MemberAttachment {
  member: string;
  replaced?: boolean;
}

type WatchClientMessage =
  | { type: "ping"; id: number }
  | { type: "send"; data: string };

function errorJSON(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export class WatchRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const member = new URL(request.url).searchParams.get("member");
    if (!member || !WATCH_MEMBER_RE.test(member)) {
      return errorJSON("invalid_member", "member is required", 400);
    }

    const others = this.members().filter((socket) => this.attachment(socket)?.member !== member);
    if (others.length >= WATCH_ROOM_CAPACITY) return errorJSON("room_full", "This room is full", 409);
    for (const socket of this.ctx.getWebSockets(member)) {
      socket.serializeAttachment({ member, replaced: true } satisfies MemberAttachment);
      socket.close(4000, "replaced");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.serializeAttachment({ member } satisfies MemberAttachment);
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
    this.send(socket, { type: "error", code: "invalid_message", message: "Unknown message" });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.leave(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.leave(socket);
  }

  private leave(socket: WebSocket): void {
    const gone = this.attachment(socket);
    try { socket.close(1000, "left"); } catch { /* already closed */ }
    if (!gone || gone.replaced) return;
    gone.replaced = true;
    socket.serializeAttachment(gone);
    for (const other of this.members()) this.send(other, { type: "left", member: gone.member });
  }

  private members(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = this.attachment(socket);
      return attachment !== null && !attachment.replaced && socket.readyState === WebSocket.OPEN;
    });
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
