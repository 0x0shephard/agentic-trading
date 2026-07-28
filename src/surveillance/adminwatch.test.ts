import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CONTRACTS } from "../config/addresses";
import { classifyRoutineAdminTransaction } from "./alerting/adminwatch";

const ADMIN = CONTRACTS.treasury;
const AGENT = "0x40AFD01884332c5969509dee0f0988C3E0602593" as Address;
const calldata = (selector: string, argumentBytes: number): Hex =>
  `${selector}${"00".repeat(argumentBytes)}` as Hex;

function tx(overrides: Partial<{ from: Address; to: Address | null; input: Hex; value: bigint }> = {}) {
  return {
    from: ADMIN,
    to: CONTRACTS.cuOracle,
    input: "0x" as Hex,
    value: 0n,
    ...overrides,
  };
}

describe("classifyRoutineAdminTransaction", () => {
  it("recognizes CuOracle commit and reveal calls", () => {
    expect(classifyRoutineAdminTransaction(tx({ input: calldata("0x5b809038", 64) })))
      .toBe("oracle-price-publication");
    expect(classifyRoutineAdminTransaction(tx({ input: calldata("0x9b55f2b0", 96) })))
      .toBe("oracle-price-publication");
  });

  it("does not suppress unknown CuOracle methods", () => {
    expect(classifyRoutineAdminTransaction(tx({ input: "0x12345678" }))).toBeUndefined();
  });

  it("recognizes plain ETH funding to a derived agent", () => {
    const recipients = new Set([AGENT.toLowerCase()]);
    expect(classifyRoutineAdminTransaction(
      tx({ to: AGENT, input: "0x", value: 10n ** 17n }),
      recipients,
    )).toBe("agent-eth-funding");
  });

  it("does not suppress transfers to unknown recipients or calls to agents", () => {
    expect(classifyRoutineAdminTransaction(
      tx({ to: AGENT, input: "0x", value: 10n ** 17n }),
    )).toBeUndefined();
    expect(classifyRoutineAdminTransaction(
      tx({ to: AGENT, input: "0x12345678", value: 0n }),
      new Set([AGENT.toLowerCase()]),
    )).toBeUndefined();
  });
});
