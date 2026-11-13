import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionResult,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { MULTICALL3 } from "../domain/addresses.js";
import { getConfig } from "../config.js";
import { redactUrl } from "./outbound.js";

const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "view",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

function makeClient(url: string) {
  return createPublicClient({
    chain: base,
    transport: http(url, {
      timeout: 4_000,
      retryCount: 0,
      batch: false,
    }),
  });
}

export type BaseClient = ReturnType<typeof makeClient>;

export interface AggregateResult {
  success: boolean;
  returnData: Hex;
}

let clientPromise: Promise<{ client: BaseClient; url: string }> | null = null;

async function probe(url: string): Promise<BaseClient | null> {
  const client = makeClient(url);
  try {
    const chainId = await client.getChainId();
    return chainId === 8453 ? client : null;
  } catch {
    return null;
  }
}

export async function getBaseClient(): Promise<BaseClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { rpcUrls } = getConfig();
      for (const url of rpcUrls) {
        const client = await probe(url);
        if (client) {
          console.log(JSON.stringify({ event: "rpc_selected", url: redactUrl(url) }));
          return { client, url };
        }
      }
      throw new Error("No Base RPC responded with chainId 8453");
    })().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return (await clientPromise).client;
}

export function resetRpcForTests(): void {
  clientPromise = null;
}

export function isTransportError(error: unknown): boolean {
  return error instanceof HttpRequestError || error instanceof TimeoutError || error instanceof RpcRequestError;
}

export async function aggregate(client: BaseClient, calls: { target: Address; data: Hex }[]): Promise<AggregateResult[]> {
  if (calls.length === 0) return [];
  const chunks: AggregateResult[] = [];
  const size = 220;
  for (let index = 0; index < calls.length; index += size) {
    const slice = calls.slice(index, index + size);
    const result = await client.readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [slice.map((call) => ({ target: call.target, allowFailure: true, callData: call.data }))],
    });
    chunks.push(...result);
  }
  return chunks;
}

export function decodeResult<TAbi extends Abi | readonly unknown[]>(
  abi: TAbi,
  functionName: string,
  data: Hex,
): unknown {
  if (!data || data === "0x") return null;
  try {
    return decodeFunctionResult({ abi: abi as Abi, functionName, data });
  } catch {
    return null;
  }
}

export function decodeWord(data: Hex, type: "uint256" | "uint160" | "uint8" | "bool" | "address"): bigint | boolean | Address | null {
  if (!data || data === "0x") return null;
  try {
    const [value] = decodeAbiParameters([{ type }], data);
    return value as bigint | boolean | Address;
  } catch {
    return null;
  }
}

export function decodeString(data: Hex): string | null {
  if (!data || data === "0x") return null;
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], data);
    const text = value.trim();
    return text.length > 0 ? text.slice(0, 64) : null;
  } catch {
    try {
      const [value] = decodeAbiParameters([{ type: "bytes32" }], data);
      const text = Buffer.from(value.slice(2), "hex").toString("utf8").replace(/\u0000/g, "").trim();
      return text.length > 0 ? text.slice(0, 64) : null;
    } catch {
      return null;
    }
  }
}
