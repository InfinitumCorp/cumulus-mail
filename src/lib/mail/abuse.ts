import { assertTenantId } from "../storage/adapter.ts";
import { newId } from "./bytes.ts";
import { sealText } from "./field-crypto.ts";
import { validEmail } from "./logic.ts";
import type { AbuseIntake } from "./hooks.ts";
import type { MailQuery } from "./query.ts";
import { createSuppressionList } from "./suppression.ts";

export function createAbuseIntake(db: MailQuery, tenantId: string): AbuseIntake {
  assertTenantId(tenantId);
  const suppressions = createSuppressionList(db, tenantId);
  return {
    async submit(report) {
      const address = report.subjectAddress.trim().toLowerCase();
      if (!validEmail(address)) throw new Error("Abuse report needs an email address");
      const reporter = report.reporter.trim().slice(0, 320);
      if (!reporter) throw new Error("Abuse report needs a reporter");
      const id = newId("abuse");
      await db.query(
        `insert into cumulus_mail.abuse_reports (
           tenant_id, id, reporter, subject_address, detail
         ) values ($1,$2,$3,$4,$5)`,
        [tenantId, id, reporter, sealText(tenantId, address), report.detail.trim().slice(0, 4000)],
      );
      await suppressions.add(address, `abuse:${id}`);
      return { id, suppressed: true as const };
    },
  };
}
