import { isAddress } from "viem";
import { checkBaseToken } from "../src/services/safety.js";

const address = process.argv[2];
if (!address || !isAddress(address)) {
  console.error("Usage: npm run check -- 0x<base-token>");
  process.exit(1);
}

const report = await checkBaseToken(address);
console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === "danger" ? 2 : 0);
