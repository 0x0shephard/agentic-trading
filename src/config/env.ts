import "dotenv/config";
import { z } from "zod";
import { CHAIN_ID } from "./constants";

// Strict boolean parsing: env values must be the literal "true"/"false".
// (Avoids the classic Boolean("false") === true footgun.)
const boolEnv = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const schema = z.object({
  SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  CHAIN_ID: z.coerce.number().int().default(CHAIN_ID),
  AGENT_MNEMONIC: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DRY_RUN: boolEnv("true"),
  KILL_SWITCH: boolEnv("false"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Hard safety rail #1: never run against anything but Sepolia.
if (env.CHAIN_ID !== CHAIN_ID) {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start: CHAIN_ID=${env.CHAIN_ID} is not Sepolia (${CHAIN_ID}).`);
  process.exit(1);
}
