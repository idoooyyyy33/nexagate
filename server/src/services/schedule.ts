export type ScheduleSlot = { weekday: number; start_time: string; end_time: string };

export function isAllowedAt(
  now: Date,
  validFrom: string | null,
  validUntil: string | null,
  schedules: ScheduleSlot[],
  timeZone: string
): boolean {
  const instant = now.getTime();
  if (validFrom && instant < Date.parse(validFrom)) return false;
  if (validUntil && instant > Date.parse(validUntil)) return false;
  if (schedules.length === 0) return true;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((part) => part.type === 'weekday')?.value ?? ''
  );
  const time = `${parts.find((part) => part.type === 'hour')?.value}:${parts.find((part) => part.type === 'minute')?.value}`;
  return schedules.some((slot) => slot.weekday === weekday && time >= slot.start_time && time < slot.end_time);
}
