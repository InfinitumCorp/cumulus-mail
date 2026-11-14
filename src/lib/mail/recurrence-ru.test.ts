import assert from "node:assert/strict";
import { test } from "node:test";
import { expandEvents } from "./calendar.ts";
import type { CalEvent } from "./model.ts";
import { describeRule, parseRRule, plural } from "./recurrence.ts";
import { interfaceLanguage } from "../interface-language.ts";

const ru = (value: string) => describeRule(parseRRule(value)!, "ru");

test("Russian plural forms: 1, 2–4, 5+, with 11–14 as many", () => {
  const forms = (n: number) => plural(n, "день", "дня", "дней");
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(forms), ["день", "дня", "дня", "дней", "дней", "дней", "дней", "день", "дня", "дней", "день", "дней"]);
});

test("recurrence rules in Russian", () => {
  assert.equal(ru("FREQ=DAILY"), "Каждый день");
  assert.equal(ru("FREQ=DAILY;INTERVAL=21"), "Каждый 21 день");
  assert.equal(ru("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10"), "Каждые 2 недели, по пн, ср · 10 раз");
  assert.equal(ru("FREQ=WEEKLY;INTERVAL=21"), "Каждую 21 неделю");
  assert.equal(ru("FREQ=MONTHLY;INTERVAL=5"), "Каждые 5 месяцев");
  assert.equal(ru("FREQ=YEARLY;INTERVAL=5"), "Каждые 5 лет");
  assert.equal(ru("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), "Каждый год, 4-й чт в ноябре");
  assert.equal(ru("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU"), "Каждый год, последний вс в марте");
  assert.equal(ru("FREQ=MONTHLY;BYMONTHDAY=1,15"), "Каждый месяц, 1-го и 15-го числа");
  assert.equal(ru("FREQ=MONTHLY;BYMONTHDAY=-1"), "Каждый месяц, в последний день");
  assert.equal(ru("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"), "Каждый месяц, 13-го числа, если это пт");
  assert.equal(ru("FREQ=MONTHLY;BYDAY=-2MO"), "Каждый месяц, 2-й с конца пн");
  assert.equal(ru("FREQ=DAILY;COUNT=3"), "Каждый день · 3 раза");
  assert.equal(ru("FREQ=YEARLY;INTERVAL=2;UNTIL=20300101"), "Каждые 2 года · до 2030-01-01");
  assert.equal(describeRule(parseRRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")!), "Every year on 4th Thu in Nov", "English is the default");
});

test("the calendar list uses the interface language for repeats and RDATE series", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const weekly: CalEvent = { id: "w", title: "Standup", whenLabel: "", where: "", with: "", sort: "2026-11-02T09:00:00.000Z", rrule: "FREQ=WEEKLY;BYDAY=MO" };
  const dated: CalEvent = { id: "d", title: "Board", whenLabel: "", where: "", with: "", sort: "2026-11-03T09:00:00.000Z", rdates: ["2026-11-10T09:00:00.000Z", "2026-11-17T09:00:00.000Z"] };
  const rows = expandEvents([weekly, dated], now, 30, 2, "ru");
  assert.match(rows.find((r) => r.id.startsWith("w@"))!.whenLabel, /· Каждую неделю, по пн$/);
  assert.match(rows.find((r) => r.id.startsWith("d@"))!.whenLabel, /· одна из 3 дат$/);
  assert.match(expandEvents([weekly], now, 30, 1)[0]!.whenLabel, /· Every week on Mon$/);
});

test("the interface language comes from <html lang>", () => {
  assert.equal(interfaceLanguage("ru"), "ru");
  assert.equal(interfaceLanguage("ru-RU"), "ru");
  assert.equal(interfaceLanguage("en"), "en");
  assert.equal(interfaceLanguage(null), "en");
});
