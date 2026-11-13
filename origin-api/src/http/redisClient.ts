import net from "node:net";
import tls from "node:tls";
import { assertOutboundUrl } from "../services/outbound.js";

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisError";
  }
}

export type RedisValue = string | number | null | RedisValue[];

interface Waiter {
  resolve: (value: RedisValue) => void;
  reject: (error: Error) => void;
}

export function encodeRedis(args: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const body = Buffer.from(arg);
    chunks.push(Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

/** Reads one RESP value from the front of `buffer`. Returns null when more bytes are required. */
export function readRedisReply(
  buffer: Buffer,
): { bytes: number; value: RedisValue } | { bytes: number; error: string } | null {
  if (buffer.length === 0) return null;
  const prefix = String.fromCharCode(buffer[0] ?? 0);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0) return null;
  const line = buffer.subarray(1, lineEnd).toString("utf8");
  if (prefix === "+") return { bytes: lineEnd + 2, value: line };
  if (prefix === "-") return { bytes: lineEnd + 2, error: line };
  if (prefix === ":") {
    if (!/^-?\d+$/.test(line)) return { bytes: lineEnd + 2, error: "invalid redis integer" };
    const value = Number(line);
    if (!Number.isSafeInteger(value)) return { bytes: lineEnd + 2, error: "redis integer is out of range" };
    return { bytes: lineEnd + 2, value };
  }
  if (prefix === "$") {
    if (!/^-?\d+$/.test(line)) return { bytes: lineEnd + 2, error: "invalid redis bulk length" };
    const length = Number(line);
    if (length === -1) return { bytes: lineEnd + 2, value: null };
    if (length < 0 || length > 1_000_000) return { bytes: lineEnd + 2, error: "redis bulk string is too large" };
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    return { bytes: start + length + 2, value: buffer.subarray(start, start + length).toString("utf8") };
  }
  if (prefix === "*") {
    if (!/^-?\d+$/.test(line)) return { bytes: lineEnd + 2, error: "invalid redis array length" };
    const count = Number(line);
    if (count === -1) return { bytes: lineEnd + 2, value: null };
    if (count < 0 || count > 64) return { bytes: lineEnd + 2, error: "redis array is too large" };
    let offset = lineEnd + 2;
    const values: RedisValue[] = [];
    for (let index = 0; index < count; index += 1) {
      const next = readRedisReply(buffer.subarray(offset));
      if (!next) return null;
      if ("error" in next) return { bytes: offset + next.bytes, error: next.error };
      values.push(next.value);
      offset += next.bytes;
    }
    return { bytes: offset, value: values };
  }
  return { bytes: Math.min(buffer.length, 64), error: "unknown redis reply" };
}

/**
 * Minimal Redis client for INCR-style usage counters.
 * Supports redis:// and rediss:// with optional AUTH and SELECT.
 */
export class RedisClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private queue: Waiter[] = [];
  private opening: Promise<void> | null = null;

  constructor(private readonly url: string) {}

  async command(args: string[]): Promise<RedisValue> {
    await this.ensure();
    return this.send(args);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
    });
  }

  private async ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (!this.opening) this.opening = this.open();
    try {
      await this.opening;
    } catch (error) {
      this.opening = null;
      throw error;
    }
  }

  private send(args: string[]): Promise<RedisValue> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new RedisError("redis is not connected"));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      socket.write(encodeRedis(args));
    });
  }

  private async open(): Promise<void> {
    const url = new URL(this.url);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new RedisError("REDIS_URL must use redis:// or rediss://");
    }
    const probe = `${url.protocol === "rediss:" ? "https" : "http"}://${url.hostname}${url.port ? `:${url.port}` : ""}`;
    assertOutboundUrl(probe, { allowHttp: true, allowPrivate: true });
    const port = Number(url.port || 6379);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RedisError("REDIS_URL port is invalid");
    const socket = await connectSocket(url.protocol === "rediss:", url.hostname, port);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(error instanceof Error ? error : new RedisError("redis socket error")));
    socket.on("close", () => {
      this.socket = null;
      this.opening = null;
      this.failAll(new RedisError("redis connection closed"));
    });
    if (url.password) {
      const password = decodeURIComponent(url.password);
      const reply = url.username
        ? await this.send(["AUTH", decodeURIComponent(url.username), password])
        : await this.send(["AUTH", password]);
      if (reply !== "OK") throw new RedisError("redis AUTH failed");
    }
    const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (db && db !== "0") {
      if (!/^\d+$/.test(db)) throw new RedisError("REDIS_URL database must be numeric");
      const selected = await this.send(["SELECT", db]);
      if (selected !== "OK") throw new RedisError("redis SELECT failed");
    }
  }

  private onData(chunk: Buffer): void {
    const next = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
    while (this.queue.length > 0) {
      const parsed = readRedisReply(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.bytes);
      const waiter = this.queue.shift();
      if (!waiter) return;
      if ("error" in parsed) waiter.reject(new RedisError(parsed.error));
      else waiter.resolve(parsed.value);
    }
  }

  private failAll(error: Error): void {
    const pending = this.queue;
    this.queue = [];
    for (const waiter of pending) waiter.reject(error);
  }
}

function connectSocket(secure: boolean, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.setTimeout(2_000, () => fail(new RedisError("redis connect timed out")));
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.off("error", fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}
