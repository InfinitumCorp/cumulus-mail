import type { CalEvent } from "./model.ts";
import { describeRule, occurrences, parseRRule } from "./recurrence.ts";

function label(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The calendar list: one row per occurrence. Repeating events show their
 * occurrences from `now` up to `horizonDays` ahead (at most `perEvent` each).
 * Declined events are left out. Sorted by time.
 */
export function expandEvents(events: CalEvent[], now = new Date(), horizonDays = 60, perEvent = 8): CalEvent[] {
  const rows: CalEvent[] = [];
  const from = now.getTime();
  const before = new Date(from + horizonDays * 86_400_000).toISOString();
  for (const event of events) {
    if (event.rsvp === "declined") continue;
    const rule = event.rrule ? parseRRule(event.rrule) : null;
    if (!rule) {
      rows.push(event);
      continue;
    }
    // EXDATE is applied after COUNT, as RFC 5545 says: an excluded date still uses up a count.
    const skipped = new Set((event.exdates ?? []).map((iso) => Date.parse(iso)));
    const upcoming = occurrences(event.sort, rule, { before })
      .filter((iso) => Date.parse(iso) >= from && !skipped.has(Date.parse(iso)))
      .slice(0, perEvent);
    const repeat = describeRule(rule);
    for (const iso of upcoming) {
      rows.push({ ...event, id: `${event.id}@${iso}`, sort: iso, whenLabel: `${label(iso)} · ${repeat}` });
    }
  }
  return rows.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
}

/** Record this mailbox's answer on its copy of the event (adding it when new). */
export function withRsvp(events: CalEvent[], invite: CalEvent, rsvp: NonNullable<CalEvent["rsvp"]>): CalEvent[] {
  const existing = events.find((event) => event.id === invite.id);
  if (existing) return events.map((event) => (event.id === invite.id ? { ...event, ...invite, rsvp } : event));
  return [...events, { ...invite, rsvp }];
}
