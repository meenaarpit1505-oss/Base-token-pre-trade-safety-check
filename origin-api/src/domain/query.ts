import { getAddress, isAddress, type Address } from "viem";
import { ZERO } from "./addresses.js";
import { HttpError } from "../http/errors.js";

export function parseTokenQuery(searchParams: URLSearchParams): { chain: "base"; address: Address } {
  const chainRaw = searchParams.get("chain")?.trim().toLowerCase() ?? "";
  if (!chainRaw) {
    throw new HttpError(400, "invalid_parameter", "Query parameter chain is required. Use chain=base.");
  }
  if (chainRaw !== "base" && chainRaw !== "8453") {
    throw new HttpError(
      400,
      "unsupported_chain",
      "Only base (chainId 8453) is enabled. Solana and other chains are not implemented.",
    );
  }
  const addressRaw = searchParams.get("address")?.trim() ?? "";
  if (!addressRaw) {
    throw new HttpError(400, "invalid_parameter", "Query parameter address is required.");
  }
  if (!isAddress(addressRaw, { strict: false })) {
    throw new HttpError(400, "invalid_address", "address must be a 20-byte hex string (0x plus 40 hex characters).");
  }
  const address = getAddress(addressRaw);
  if (address === ZERO) {
    throw new HttpError(400, "invalid_address", "address must not be the zero address.");
  }
  return { chain: "base", address };
}
