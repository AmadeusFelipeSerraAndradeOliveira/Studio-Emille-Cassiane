import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../assets/config.js";
import {
  addCalendarDays, bookingIsLogicallyExpired, buildPeriodRange, currentPrice, eligibleForRetention,
  epochDay, generateTimeOptions, getSlotLockIds, makeCsv, normalizePhone, whatsappUrl, zonedDateTimeToUtc,
} from "../assets/domain.js";

const timezone = "America/Araguaina";

test("configuração aponta para o app Firebase e UID informados", () => {
  assert.equal(CONFIG.firebase.projectId, "studio-cassiana-emille");
  assert.equal(CONFIG.firebase.appId, "1:90344996694:web:75400f251b9397b7dc20f7");
  assert.deepEqual(CONFIG.authorizedAdminUids, ["4zC1SQs7YRQ0FfkGARdImqu2w7z1"]);
  assert.equal(CONFIG.whatsappE164, "5563984007189");
  assert.equal(CONFIG.address, "Bertaville, Rua Zeca de Moraes, QD 32, LT 09");
});

test("converte horário local do studio para instante UTC", () => {
  const value = zonedDateTimeToUtc("2026-10-20", "10:30", timezone);
  assert.equal(value.toISOString(), "2026-10-20T13:30:00.000Z");
});

test("gera horários em blocos de 30 minutos, respeitando expediente e intervalo", () => {
  const schedule = {
    enabled: true, openMinute: 9 * 60, closeMinute: 17 * 60,
    breakStartMinute: 12 * 60, breakEndMinute: 13 * 60,
    workingDays: [1, 2, 3, 4, 5], holidays: [], minimumLeadMinutes: 0, daysAhead: 60,
  };
  const slots = generateTimeOptions({ date: "2026-10-19", service: { durationMinutes: 60 }, schedule, timezone, now: new Date("2026-10-18T12:00:00Z") });
  const times = slots.map((slot) => slot.time);
  assert.ok(times.includes("09:00"));
  assert.ok(times.includes("13:00"));
  assert.ok(!times.includes("11:30"));
  assert.ok(!times.includes("16:30"));
});

test("não oferece horários em folga, feriado ou fora do prazo configurado", () => {
  const date = "2026-10-19";
  const schedule = {
    enabled: true, openMinute: 9 * 60, closeMinute: 17 * 60, breakStartMinute: -1, breakEndMinute: -1,
    workingDays: [1, 2, 3, 4, 5], holidays: [epochDay(date)], minimumLeadMinutes: 0, daysAhead: 1,
  };
  assert.deepEqual(generateTimeOptions({ date, service: { durationMinutes: 30 }, schedule, timezone, now: new Date("2026-10-18T12:00:00Z") }), []);
  assert.deepEqual(generateTimeOptions({ date: "2026-10-22", service: { durationMinutes: 30 }, schedule: { ...schedule, holidays: [] }, timezone, now: new Date("2026-10-18T12:00:00Z") }), []);
});

test("serviços de maior duração bloqueiam todas as fatias de 30 minutos", () => {
  const ids = getSlotLockIds(new Date("2026-10-20T13:00:00.000Z"), 90);
  assert.equal(ids.length, 3);
  assert.equal(Number(ids[1]) - Number(ids[0]), 30 * 60_000);
  assert.equal(Number(ids[2]) - Number(ids[1]), 30 * 60_000);
});

test("a promoção respeita o período configurado", () => {
  const service = { basePriceCents: 10000, promoPriceCents: 7500, promoStartsAt: new Date("2026-10-01T00:00:00Z"), promoEndsAt: new Date("2026-11-01T00:00:00Z") };
  assert.deepEqual(currentPrice(service, new Date("2026-10-20T12:00:00Z")), { cents: 7500, promo: true });
  assert.deepEqual(currentPrice(service, new Date("2026-11-01T00:00:00Z")), { cents: 10000, promo: false });
});

test("pedido pendente expira logicamente e a janela da agenda usa horário local", () => {
  const booking = { status: "pending", expiresAt: new Date("2026-10-20T13:30:00Z") };
  assert.equal(bookingIsLogicallyExpired(booking, new Date("2026-10-20T13:31:00Z")), true);
  const range = buildPeriodRange("day", "2026-10-20", timezone);
  assert.equal(range.start.toISOString(), "2026-10-20T03:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-10-21T03:00:00.000Z");
  assert.equal(addCalendarDays("2026-10-31", 1), "2026-11-01");
});

test("retenção preserva pedidos pendentes, confirmados e futuros", () => {
  const cutoff = new Date("2026-10-01T00:00:00Z");
  const oldSlot = new Date("2026-08-01T00:00:00Z");
  assert.equal(eligibleForRetention({ status: "cancelled", slotAt: oldSlot }, cutoff, new Date("2026-10-20T00:00:00Z")), true);
  for (const status of ["pending", "confirmed"]) {
    assert.equal(eligibleForRetention({ status, slotAt: oldSlot }, cutoff, new Date("2026-10-20T00:00:00Z")), false);
  }
  assert.equal(eligibleForRetention({ status: "refused", slotAt: new Date("2026-12-01T00:00:00Z") }, cutoff, new Date("2026-10-20T00:00:00Z")), false);
});

test("telefone e link de WhatsApp são normalizados e a mensagem é codificada", () => {
  assert.equal(normalizePhone("(11) 99999-8888"), "11999998888");
  assert.match(whatsappUrl("5511999998888", "Olá Studio"), /^https:\/\/wa\.me\/5511999998888\?text=/);
  assert.throws(() => normalizePhone("12345"), /telefone/);
});

test("CSV mantém acentos e escapa aspas e quebras de linha", () => {
  const csv = makeCsv([["Nome", "Observação"], ["João", '“quero, sim”\nlinha 2']]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"João"'));
  assert.ok(csv.includes('"“quero, sim” linha 2"'));
});

