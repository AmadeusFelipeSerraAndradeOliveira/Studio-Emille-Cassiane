export const STATUS_LABELS = Object.freeze({
  pending: "Pendente",
  confirmed: "Confirmado",
  refused: "Recusado",
  expired: "Expirado",
  cancelled: "Cancelado",
  completed: "Finalizado",
  no_show: "Não compareceu",
});

export function centsToMoney(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function moneyToCents(value) {
  const amount = Number(String(value).replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Informe um preço maior que zero.");
  return Math.round(amount * 100);
}

export function currentPrice(service, now = new Date()) {
  const start = service.promoStartsAt?.toDate?.() ?? service.promoStartsAt ?? null;
  const end = service.promoEndsAt?.toDate?.() ?? service.promoEndsAt ?? null;
  const promo = Number.isInteger(service.promoPriceCents)
    && start instanceof Date && end instanceof Date
    && start <= now && now < end;
  return { cents: promo ? service.promoPriceCents : service.basePriceCents, promo };
}

export function epochDay(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function dateStringFromEpochDay(day) {
  return new Date(Number(day) * 86_400_000).toISOString().slice(0, 10);
}

export function addCalendarDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

export function weekdayForDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const dayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dayIndex === 0 ? 7 : dayIndex;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function zonedDateTimeToUtc(dateString, timeString, timezone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = timeString.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = zonedParts(new Date(guess), timezone);
    const displayed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = desired - displayed;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

export function formatDateTime(value, timezone) {
  const date = value?.toDate?.() ?? new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone, weekday: "short", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

export function formatDateOnly(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function localDateInputValue(timezone, now = new Date()) {
  const parts = zonedParts(now, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function generateTimeOptions({ date, service, schedule, timezone, now = new Date() }) {
  if (!schedule?.enabled || !Number.isInteger(schedule.openMinute) || !Number.isInteger(schedule.closeMinute)) return [];
  const day = epochDay(date);
  const today = epochDay(localDateInputValue(timezone, now));
  if (day < today || day > today + schedule.daysAhead) return [];
  if (!schedule.workingDays?.includes(weekdayForDate(date)) || schedule.holidays?.includes(day)) return [];
  const duration = Number(service?.durationMinutes);
  const output = [];
  for (let minute = schedule.openMinute; minute + duration <= schedule.closeMinute; minute += 30) {
    const overlapsBreak = Number.isInteger(schedule.breakStartMinute)
      && Number.isInteger(schedule.breakEndMinute)
      && schedule.breakEndMinute > schedule.breakStartMinute
      && minute < schedule.breakEndMinute
      && minute + duration > schedule.breakStartMinute;
    if (overlapsBreak) continue;
    const hour = Math.floor(minute / 60);
    const min = minute % 60;
    const time = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    const slotAt = zonedDateTimeToUtc(date, time, timezone);
    if (slotAt.getTime() < now.getTime() + schedule.minimumLeadMinutes * 60_000) continue;
    output.push({ time, minute, slotAt, lockIds: getSlotLockIds(slotAt, duration) });
  }
  return output;
}

export function getSlotLockIds(slotAt, durationMinutes) {
  const start = slotAt instanceof Date ? slotAt.getTime() : slotAt.toDate().getTime();
  const blocks = Math.ceil(Number(durationMinutes) / 30);
  return Array.from({ length: blocks }, (_, index) => String(start + index * 30 * 60_000));
}

export function buildPeriodRange(mode, dateString, timezone) {
  let first = dateString;
  let last;
  if (mode === "week") {
    const mondayOffset = (weekdayForDate(dateString) + 6) % 7;
    first = addCalendarDays(dateString, -mondayOffset);
    last = addCalendarDays(first, 7);
  } else if (mode === "month") {
    const [year, month] = dateString.split("-").map(Number);
    first = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    last = nextMonth;
  } else {
    last = addCalendarDays(first, 1);
  }
  return {
    start: zonedDateTimeToUtc(first, "00:00", timezone),
    end: zonedDateTimeToUtc(last, "00:00", timezone),
    label: mode === "day" ? first : `${first} — ${addCalendarDays(last, -1)}`,
  };
}

export function bookingIsLogicallyExpired(booking, now = new Date()) {
  const expiry = booking.expiresAt?.toDate?.() ?? (booking.expiresAt ? new Date(booking.expiresAt) : null);
  return booking.status === "pending" && expiry instanceof Date && expiry.getTime() <= now.getTime();
}

export function eligibleForRetention(booking, cutoff, now = new Date()) {
  const status = booking.status;
  const terminal = ["refused", "expired", "cancelled"].includes(status);
  const at = booking.slotAt?.toDate?.() ?? new Date(booking.slotAt);
  return terminal && at instanceof Date && !Number.isNaN(at.getTime()) && at < cutoff && at < now;
}

export function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) throw new Error("Informe um telefone com DDD.");
  return digits;
}

export function whatsappUrl(phone, message) {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(message)}`;
}

export function csvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

export function makeCsv(rows) {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}

export function summarizeFinance(bookings, expenses, receipts = bookings) {
  const completed = bookings.filter((booking) => booking.status === "completed");
  const receivedCents = receipts.reduce((sum, booking) => sum + Number(booking.receivedCents || 0), 0);
  const receivableCents = completed.reduce((sum, booking) => sum + Math.max(0, Number(booking.priceCents || 0) - Number(booking.receivedCents || 0)), 0);
  const expenseCents = expenses.reduce((sum, expense) => sum + Number(expense.amountCents || 0), 0);
  return {
    receivedCents,
    receivableCents,
    expenseCents,
    balanceCents: receivedCents - expenseCents,
    completedCount: completed.length,
    noShowCount: bookings.filter((booking) => booking.status === "no_show").length,
    expenseCount: expenses.length,
  };
}
