import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  collection, deleteDoc, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from "firebase/firestore";
import { getSlotLockIds, zonedDateTimeToUtc } from "../assets/domain.js";

const projectId = "demo-studio-emille";
const adminUid = "4zC1SQs7YRQ0FfkGARdImqu2w7z1";
let testEnv;
let serviceData;
let scheduleData;

before(async () => {
  let rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules },
  });
  serviceData = {
    name: "Serviço de teste", description: "Serviço para validar regras.", durationMinutes: 60,
    basePriceCents: 10000, promoPriceCents: null, promoStartsAt: null, promoEndsAt: null,
    active: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  };
  scheduleData = {
    enabled: true, openMinute: 9 * 60, closeMinute: 18 * 60,
    breakStartMinute: 12 * 60, breakEndMinute: 13 * 60,
    workingDays: [1, 2, 3, 4, 5, 6, 7], holidays: [],
    minimumLeadMinutes: 0, daysAhead: 120,
  };
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await setDoc(doc(database, "services", "service-test"), serviceData);
    await setDoc(doc(database, "settings", "public"), scheduleData);
    await setDoc(doc(database, "staff", "emille"), {
      name: "Emille", active: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    await setDoc(doc(database, "staff", "cassiane"), {
      name: "Cassiane", active: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    await setDoc(doc(database, "staff", "inactive"), {
      name: "Profissional inativa", active: false, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
  });
});

after(async () => testEnv?.cleanup());

function futureSlot(daysAhead = 4, time = "10:00") {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Araguaina", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const slotAt = zonedDateTimeToUtc(localDate, time, "America/Araguaina");
  return { localDate, slotAt, minute: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) };
}

async function submitBooking(database, options = {}) {
  const { localDate, slotAt, minute } = options.slot || futureSlot();
  const durationMinutes = options.durationMinutes || 60;
  const lockIds = getSlotLockIds(slotAt, durationMinutes);
  const bookingRef = doc(collection(database, "bookings"));
  const lockRefs = lockIds.map((id) => doc(database, "slotLocks", id));
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 30 * 60_000));
  const booking = {
    name: "Ana Teste", phone: "11999998888", serviceId: "service-test", serviceName: "Serviço de teste",
    staffId: options.staffId || "emille", staffName: options.staffName || (options.staffId === "cassiane" ? "Cassiane" : "Emille"),
    durationMinutes, priceCents: options.priceCents ?? 10000,
    slotAt: Timestamp.fromDate(slotAt), slotMinute: minute, slotLockIds: lockIds,
    notes: "", status: "pending", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), expiresAt,
  };
  await runTransaction(database, async (transaction) => {
    const locks = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
    const now = Date.now();
    if (locks.some((item) => item.exists() && !(item.data().status === "pending" && item.data().expiresAt?.toDate().getTime() <= now))) {
      throw new Error("slot occupied");
    }
    transaction.set(bookingRef, booking);
    lockRefs.forEach((ref, index) => transaction.set(ref, {
      bookingId: bookingRef.id,
      status: "pending",
      slotAt: Timestamp.fromMillis(Number(lockIds[index])),
      expiresAt,
    }));
  });
  return { bookingRef, lockRefs, lockIds };
}

test("visitor lê serviços ativos, mas não lê nem lista reservas", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(getDocs(query(collection(visitor, "services"), where("active", "==", true))));
  await assertSucceeds(getDoc(doc(visitor, "settings", "public")));
  await assertSucceeds(getDocs(query(collection(visitor, "staff"), where("active", "==", true))));
  await assertFails(getDoc(doc(visitor, "staff", "inactive")));
  await assertFails(setDoc(doc(visitor, "staff", "injected"), { name: "Fraude", active: true }));
  await assertFails(getDoc(doc(visitor, "settings", "admin")));
  await assertFails(getDoc(doc(visitor, "bookings", "guessable")));
  await assertFails(getDocs(collection(visitor, "bookings")));
});

test("criação atômica cria um pedido pendente e bloqueia as fatias sobrepostas", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  const slot = futureSlot(4, "10:00");
  const first = await submitBooking(visitor, { slot });
  await assertFails(getDoc(first.bookingRef));
  await assert.rejects(() => submitBooking(visitor, { slot }), /slot occupied|permission/i);
});

test("pedido registra uma profissional ativa e rejeita nome adulterado ou profissional inativa", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  const valid = await submitBooking(visitor, { slot: futureSlot(11, "10:00"), staffId: "cassiane" });
  assert.equal((await getDoc(doc(testEnv.authenticatedContext(adminUid).firestore(), "bookings", valid.bookingRef.id))).data().staffName, "Cassiane");
  await assert.rejects(() => submitBooking(visitor, { slot: futureSlot(12, "10:00"), staffId: "inactive" }), /permission/i);
  await assert.rejects(() => submitBooking(visitor, { slot: futureSlot(13, "10:00"), staffId: "cassiane", staffName: "Emille" }), /permission/i);
});

test("regras negam preço adulterado e acesso de usuário comum a status", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  await assert.rejects(() => submitBooking(visitor, { slot: futureSlot(5, "16:00"), priceCents: 1 }), /permission/i);
  const booking = await submitBooking(visitor, { slot: futureSlot(6, "11:00") });
  const ordinaryUser = testEnv.authenticatedContext("authenticated-but-not-admin").firestore();
  await assertFails(getDoc(doc(ordinaryUser, "bookings", booking.bookingRef.id)));
  await assertFails(updateDoc(doc(ordinaryUser, "bookings", booking.bookingRef.id), { status: "confirmed" }));
});

test("reservas concorrentes para o mesmo horário têm um único vencedor", async () => {
  const firstClient = testEnv.unauthenticatedContext().firestore();
  const secondClient = testEnv.unauthenticatedContext().firestore();
  const slot = futureSlot(7, "14:00");
  const results = await Promise.allSettled([
    submitBooking(firstClient, { slot }),
    submitBooking(secondClient, { slot }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});

test("pedido expirado libera as chaves do horário sem exclusão automática", async () => {
  const slot = futureSlot(8, "15:00");
  const lockIds = getSlotLockIds(slot.slotAt, 60);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    const expiresAt = Timestamp.fromDate(new Date(Date.now() - 1000));
    const oldRef = doc(database, "bookings", "old-expired-booking");
    await setDoc(oldRef, {
      name: "Registro expirado", phone: "11999998888", serviceId: "service-test", serviceName: "Serviço de teste",
      durationMinutes: 60, priceCents: 10000, slotAt: Timestamp.fromDate(slot.slotAt), slotMinute: slot.minute,
      slotLockIds: lockIds, notes: "", status: "pending", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), expiresAt,
    });
    for (let index = 0; index < lockIds.length; index += 1) {
      await setDoc(doc(database, "slotLocks", lockIds[index]), {
        bookingId: oldRef.id, status: "pending", slotAt: Timestamp.fromMillis(Number(lockIds[index])), expiresAt,
      });
    }
  });
  const visitor = testEnv.unauthenticatedContext().firestore();
  const next = await submitBooking(visitor, { slot });
  assert.ok(next.bookingRef.id);
  const admin = testEnv.authenticatedContext(adminUid).firestore();
  assert.equal((await getDoc(doc(admin, "bookings", "old-expired-booking"))).data().status, "pending");
});

test("somente UID autorizado consegue aprovar o pedido junto com seus bloqueios", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  const booking = await submitBooking(visitor, { slot: futureSlot(9, "10:30") });
  const admin = testEnv.authenticatedContext(adminUid).firestore();
  const adminBookingRef = doc(admin, "bookings", booking.bookingRef.id);
  const adminLockRefs = booking.lockIds.map((id) => doc(admin, "slotLocks", id));
  await assertSucceeds(getDoc(adminBookingRef));
  await runTransaction(admin, async (transaction) => {
    const reservation = await transaction.get(adminBookingRef);
    const locks = await Promise.all(adminLockRefs.map((ref) => transaction.get(ref)));
    transaction.update(adminBookingRef, { status: "confirmed", updatedAt: serverTimestamp(), decisionAt: serverTimestamp() });
    adminLockRefs.forEach((ref, index) => {
      if (locks[index].exists()) transaction.update(ref, { status: "confirmed", expiresAt: null });
    });
    assert.equal(reservation.data().status, "pending");
  });
  const confirmed = await getDoc(adminBookingRef);
  assert.equal(confirmed.data().status, "confirmed");
});

test("somente o administrador finaliza atendimento e remove bloqueios", async () => {
  const visitor = testEnv.unauthenticatedContext().firestore();
  const booking = await submitBooking(visitor, { slot: futureSlot(10, "11:30") });
  const admin = testEnv.authenticatedContext(adminUid).firestore();
  const bookingRef = doc(admin, "bookings", booking.bookingRef.id);
  const locks = booking.lockIds.map((id) => doc(admin, "slotLocks", id));
  await runTransaction(admin, async (transaction) => {
    const fresh = await transaction.get(bookingRef);
    await Promise.all(locks.map((ref) => transaction.get(ref)));
    transaction.update(bookingRef, {
      status: "confirmed", updatedAt: serverTimestamp(), decisionAt: serverTimestamp(),
    });
    locks.forEach((ref) => transaction.update(ref, { status: "confirmed", expiresAt: null }));
  });
  await runTransaction(admin, async (transaction) => {
    await transaction.get(bookingRef);
    await Promise.all(locks.map((ref) => transaction.get(ref)));
    transaction.update(bookingRef, {
      status: "completed", receivedCents: 7500, paymentMethod: "pix",
      completedAt: serverTimestamp(), paymentAt: serverTimestamp(),
      updatedAt: serverTimestamp(), decisionAt: serverTimestamp(),
    });
    locks.forEach((ref) => transaction.delete(ref));
  });
  assert.equal((await getDoc(bookingRef)).data().status, "completed");
  await assertFails(updateDoc(doc(visitor, "bookings", booking.bookingRef.id), { status: "no_show" }));
  await assertSucceeds(deleteDoc(bookingRef));
  assert.equal((await getDoc(bookingRef)).exists(), false);
});

test("dados financeiros são privados e somente o administrador registra despesas", async () => {
  const admin = testEnv.authenticatedContext(adminUid).firestore();
  const visitor = testEnv.unauthenticatedContext().firestore();
  const expense = doc(admin, "expenses", "expense-test");
  await assertSucceeds(setDoc(expense, {
    occurredAt: Timestamp.now(), amountCents: 12500, category: "Produtos e materiais",
    description: "Itens de maquiagem", createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(getDoc(expense));
  await assertFails(getDoc(doc(visitor, "expenses", "expense-test")));
  await assertFails(setDoc(doc(visitor, "expenses", "expense-public"), {
    occurredAt: Timestamp.now(), amountCents: 1, category: "Teste", description: "Sem autorização",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
});
