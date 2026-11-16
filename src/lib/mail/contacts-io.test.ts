import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { foldLine, mergeContacts, parseContactsFile, parseCsv, parseVCards, toVCards } from "./contacts-io.ts";
import type { Contact } from "./model.ts";

const sample = (name: string) => readFileSync(new URL(`./fixtures/contacts/${name}`, import.meta.url), "utf8");
let n = 0;
const newId = () => `c-${++n}`;

test("Google Contacts CSV: multi-line cells, ::: lists, quoted commas, the mixed-case email lowered", () => {
  const rows = parseContactsFile("contacts.csv", sample("google-contacts.csv"));
  assert.equal(rows.length, 4);
  const leah = rows[0]!;
  assert.equal(leah.name, "Leah Okonkwo");
  assert.equal(leah.email, "leah@cumuluscloud.app", "the first of 'a ::: b' is the primary");
  assert.equal(leah.org, "VYRAL");
  assert.equal(leah.phone, "+44 20 7946 0958");
  assert.equal(leah.address, "1 Canada Square, London E14 5AB, United Kingdom");
  assert.equal(leah.note, "Met at the London offsite.\r\nPrefers mornings, not Fridays.");
  assert.equal(rows[1]!.name, "Chen, Mira");
  assert.equal(rows[1]!.org, "Chen & Co., Ltd");
  assert.equal(rows[2]!.email, "priya@example.com");
  assert.equal(rows[3]!.email, "", "a row with no email is read, then skipped at merge");
});

test("Outlook CSV: BOM, the wide header, first + last name", () => {
  const rows = parseContactsFile("outlook.csv", sample("outlook.csv"));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { name: rows[0]!.name, email: rows[0]!.email, org: rows[0]!.org, phone: rows[0]!.phone, note: rows[0]!.note },
    { name: "Jordan Hale", email: "jordan.hale@example.org", org: "Hale Partners", phone: "+1 (555) 010-2233", note: "Board liaison" },
  );
});

test("Apple vCard 3.0: grouped properties, pref, escapes, a folded NOTE, a card with only FN", () => {
  const [chidi, team] = parseVCards(sample("apple-3.0.vcf"));
  assert.equal(chidi!.name, "Chidi Okafor");
  assert.equal(chidi!.email, "chidi@northwind.example", "type=pref wins over the other address");
  assert.equal(chidi!.org, "Northwind, Inc.", "escaped comma, first ORG component");
  assert.equal(chidi!.phone, "+234 803 555 0100");
  assert.equal(chidi!.address, "12 Marina Road, Lagos, 101231, Nigeria");
  assert.equal(chidi!.note, "Line one\nLine two with a comma, and a semicolon; here. This note is long enough to be folded by the exporter at seventy-five octets.");
  assert.equal(team!.name, "Grok Team");
});

test("Android vCard 2.1: QUOTED-PRINTABLE UTF-8 Cyrillic, soft line breaks, bare TYPE params", () => {
  const [ivan] = parseVCards(sample("android-2.1.vcf"));
  assert.equal(ivan!.name, "Иван Иванов");
  assert.equal(ivan!.email, "ivan.ivanov@yandex.example");
  assert.equal(ivan!.phone, "+7 916 555-01-23");
  assert.equal(ivan!.note, "Коллега из Москвы", "a soft break (= at line end) joins the lines");
});

test("vCard 4.0 (RFC 6350 example): tel: URI, quoted TYPE list, ORG, ADR", () => {
  const [simon] = parseVCards(sample("rfc6350-4.0.vcf"));
  assert.equal(simon!.name, "Simon Perreault");
  assert.equal(simon!.email, "simon.perreault@viagenie.ca");
  assert.equal(simon!.org, "Viagenie");
  assert.equal(simon!.phone, "+1-418-656-9254;ext=102");
  assert.equal(simon!.address, "Suite D2-630, 2875 Laurier, Quebec, QC, G1V 2M2, Canada");
});

test("merge: adds new, fills only empty fields, never overwrites, skips no-email rows, folds in-file duplicates", () => {
  const existing: Contact[] = [{ id: "keep", name: "Leah O.", email: "leah@cumuluscloud.app", org: "", note: "my own note" }];
  const google = parseContactsFile("g.csv", sample("google-contacts.csv"));
  const outlook = parseContactsFile("o.csv", sample("outlook.csv"));
  const { contacts, report } = mergeContacts(existing, [...google, ...outlook], newId);
  const leah = contacts.find((c) => c.email === "leah@cumuluscloud.app")!;
  assert.equal(leah.id, "keep");
  assert.equal(leah.name, "Leah O.", "the person's own name is kept");
  assert.equal(leah.note, "my own note", "the person's own note is kept");
  assert.equal(leah.org, "VYRAL", "an empty field is filled");
  assert.equal(leah.phone, "+44 20 7946 0958");
  assert.deepEqual(report, { added: 3, updated: 1, unchanged: 0, skipped: 1, duplicatesInFile: 1 });
  assert.equal(contacts.filter((c) => c.email === "leah@cumuluscloud.app").length, 1, "no duplicate contact");

  const again = mergeContacts(contacts, [...google, ...outlook], newId);
  assert.equal(again.report.added, 0, "importing the same files twice adds nothing");
  assert.equal(again.contacts.length, contacts.length);
});

test("export: valid vCard 4.0 with escaping, CRLF and folding, that reads back the same", () => {
  const contacts: Contact[] = [
    { id: "a", name: "Chen, Mira", email: "mira.chen@example.com", org: "Chen & Co.; Ltd", note: "Line 1\nLine 2", phone: "+1 (555) 010-2233" },
    { id: "b", name: "Иван Иванов", email: "ivan@yandex.example", org: "", note: "x".repeat(200) },
  ];
  const text = toVCards(contacts);
  assert.ok(text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n"));
  assert.ok(text.includes("FN:Chen\\, Mira\r\n"));
  assert.ok(text.includes("ORG:Chen & Co.\\; Ltd\r\n"), "a literal ; is escaped, so the org is not split into org;unit");
  assert.ok(text.includes("TEL;VALUE=uri:tel:+15550102233\r\n"));
  for (const line of text.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line.length}`);
  const back = parseVCards(text);
  assert.deepEqual(back.map((c) => [c.name, c.email, c.org, c.note]), contacts.map((c) => [c.name, c.email, c.org, c.note]));
  assert.notEqual(text.match(/UID:urn:uuid:[0-9a-f-]{36}/g)?.[0], text.match(/UID:urn:uuid:[0-9a-f-]{36}/g)?.[1], "distinct UIDs");
  assert.equal(toVCards(contacts), text, "the export is stable, so a re-import updates rather than duplicates");
});

test("folding never splits a multi-byte character", () => {
  const folded = foldLine(`NOTE:${"Ж".repeat(60)}`);
  for (const part of folded.split("\r\n ")) assert.equal(part.includes("�"), false);
  assert.equal(folded.replace(/\r\n /g, ""), `NOTE:${"Ж".repeat(60)}`);
});

test("CSV parser: semicolon files, quoted quotes, blank lines", () => {
  assert.deepEqual(parseCsv('Name;Email\r\n"Smith; ""Bob""";bob@example.com\r\n\r\n'), [["Name", "Email"], ['Smith; "Bob"', "bob@example.com"]]);
});
