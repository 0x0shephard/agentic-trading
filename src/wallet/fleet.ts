import type { Account } from "viem";
import { agentAccount } from "../chain/clients";
import { TREASURY_INDEX } from "../config/provisioning";

export interface FleetMember {
  index: number;
  account: Account;
  isTreasury: boolean;
}

/** The treasury/funder account (HD index 0). */
export function treasury(): Account {
  return agentAccount(TREASURY_INDEX);
}

/** Agent accounts for indices 1..count (the treasury is excluded). */
export function agentMembers(count: number): FleetMember[] {
  const members: FleetMember[] = [];
  for (let i = 1; i <= count; i++) {
    members.push({ index: i, account: agentAccount(i), isTreasury: false });
  }
  return members;
}
