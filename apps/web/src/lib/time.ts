export class LocalTimeError extends Error {}
export function zonedDateTimeToIso(value: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new LocalTimeError('Enter a complete date and time.');
  const wanted = new Date(`${value}:00Z`); if (Number.isNaN(wanted.valueOf())) throw new LocalTimeError('Enter a valid date and time.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const partsAt = (instant: number) => { const p = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type,p.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const offsets = new Set<number>();
  for (let hours = -24; hours <= 24; hours += 4) { const sample = wanted.valueOf() + hours * 3_600_000; const local = partsAt(sample); offsets.add(new Date(`${local}:00Z`).valueOf() - sample); }
  const candidates = [...offsets].map(offset => wanted.valueOf() - offset).filter(time => partsAt(time) === value);
  if (!candidates.length) throw new LocalTimeError('This local time does not exist because the clocks change. Choose another time.');
  if (candidates.length > 1) throw new LocalTimeError('This local time occurs twice because the clocks change. Choose a time outside that repeated hour.');
  return new Date(candidates[0]!).toISOString();
}
