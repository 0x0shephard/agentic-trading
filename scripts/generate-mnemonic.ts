// Generates a FRESH testnet mnemonic. Prints only — writes nothing.
// Paste the result into agent/.env as AGENT_MNEMONIC.
import { generateMnemonic, english } from "viem/accounts";

const mnemonic = generateMnemonic(english);

console.log("\nFresh TESTNET mnemonic — paste into agent/.env as AGENT_MNEMONIC=\n");
console.log("  " + mnemonic + "\n");
console.log("⚠  Testnet ONLY. Never use a mnemonic that controls real funds.\n");
