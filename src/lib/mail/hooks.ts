/**
 * Bounce and abuse hooks. The tenant is bound when the implementation is
 * created, from the verified session or from the recipient resolved by the
 * inbound path. Report bodies cannot choose a tenant.
 */

export type AbuseReport = {
  reporter: string;
  subjectAddress: string;
  detail: string;
};

export interface AbuseIntake {
  submit(report: AbuseReport): Promise<{ id: string; suppressed: true }>;
}

export type BounceReceipt = {
  recipient: string;
  action: string;
  status: string;
  diagnostic: string;
  suppressed: boolean;
};

export interface BounceHandler {
  accept(rawDsn: string): Promise<BounceReceipt[]>;
}

export interface SuppressionList {
  has(address: string): Promise<boolean>;
  add(address: string, reason: string): Promise<void>;
  list(): Promise<Array<{ address: string; reason: string }>>;
}
