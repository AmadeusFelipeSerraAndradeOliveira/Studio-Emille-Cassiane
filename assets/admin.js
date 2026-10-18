import { CONFIG, DEFAULT_SCHEDULE } from "./config.js";
import {
  STATUS_LABELS, addCalendarDays, buildPeriodRange, centsToMoney, currentPrice, eligibleForRetention,
  epochDay, formatDateTime, getSlotLockIds, localDateInputValue, makeCsv, moneyToCents, summarizeFinance,
  zonedDateTimeToUtc,
} from "./domain.js";
import { auth, db, firebaseReady, sdk } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const loginPanel = $("login-panel");
const dashboard = $("dashboard");
const setupNotice = $("setup-notice");
const views = ["agenda", "services", "schedule", "finance", "data"];
const statusLabels = STATUS_LABELS;
const terminalStatuses = ["refused", "expired", "cancelled", "completed", "no_show"];
let currentUser = null;
let settings = { ...DEFAULT_SCHEDULE, lastExportAt: null, lastExportIds: [], lastCleanupAt: null, lastCleanupCount: 0 };
let services = [];
let agendaBookings = [];
let agendaCursor = null;
let agendaHasMore = false;
let retentionCandidates = [];
let retentionExportedIds = [];
let isLoadingAgenda = false;
let financeReceipts = [];
let financeExpenses = [];

for (const node of document.querySelectorAll("[data-studio-name]")) node.textContent = CONFIG.studioName;

function setStatus(id, message, error = false) {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle("is-error", error);
}

function setDashboardAlert(message = "") {
  const node = $("dashboard-alert");
  node.textContent = message;
  node.hidden = !message;
}

function localMidnightTimestamp(dateString) {
  return sdk.Timestamp.fromDate(zonedDateTimeToUtc(dateString, "00:00", CONFIG.timezone));
}

function formSchedule() {
  return {
    ...settings,
    enabled: true,
    openMinute: timeToMinute($("schedule-form").elements.openTime.value),
    closeMinute: timeToMinute($("schedule-form").elements.closeTime.value),
    breakStartMinute: $("schedule-form").elements.breakStart.value ? timeToMinute($("schedule-form").elements.breakStart.value) : -1,
    breakEndMinute: $("schedule-form").elements.breakEnd.value ? timeToMinute($("schedule-form").elements.breakEnd.value) : -1,
    workingDays: [...document.querySelectorAll('input[name="weekday"]:checked')].map((item) => Number(item.value)),
    holidays: [...new Set($("schedule-form").elements.holidays.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).map((value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Data de feriado inválida: ${value}`);
      return epochDay(value);
    }))],
    minimumLeadMinutes: Number($("schedule-form").elements.minimumLeadHours.value) * 60,
    daysAhead: Number($("schedule-form").elements.daysAhead.value),
  };
}

function timeToMinute(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error("Informe um horário válido.");
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new Error("Informe um horário válido.");
  return hours * 60 + minutes;
}

function minuteToTime(value) {
  if (value < 0) return "";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function publicSchedulePayload(next) {
  return {
    enabled: Boolean(next.enabled),
    openMinute: Number(next.openMinute),
    closeMinute: Number(next.closeMinute),
    breakStartMinute: Number(next.breakStartMinute),
    breakEndMinute: Number(next.breakEndMinute),
    workingDays: next.workingDays,
    holidays: next.holidays,
    minimumLeadMinutes: Number(next.minimumLeadMinutes),
    daysAhead: Number(next.daysAhead),
  };
}

function maintenancePayload(next) {
  return {
    retentionDays: 60,
    retentionEnabled: Boolean(next.retentionEnabled),
    lastExportAt: next.lastExportAt ?? null,
    lastExportIds: Array.isArray(next.lastExportIds) ? next.lastExportIds.slice(0, 100) : [],
    lastCleanupAt: next.lastCleanupAt ?? null,
    lastCleanupCount: Number(next.lastCleanupCount || 0),
  };
}

function mergeSettings(publicValue, maintenanceValue = {}) {
  settings = { ...DEFAULT_SCHEDULE, ...(publicValue || {}), ...(maintenanceValue || {}) };
  settings.workingDays = Array.isArray(settings.workingDays) ? settings.workingDays : [];
  settings.holidays = Array.isArray(settings.holidays) ? settings.holidays : [];
  settings.lastExportIds = Array.isArray(settings.lastExportIds) ? settings.lastExportIds : [];
  fillScheduleForm();
  renderRetentionState();
}

function fillScheduleForm() {
  const form = $("schedule-form");
  form.elements.openTime.value = minuteToTime(settings.openMinute);
  form.elements.closeTime.value = minuteToTime(settings.closeMinute);
  form.elements.breakStart.value = minuteToTime(settings.breakStartMinute);
  form.elements.breakEnd.value = minuteToTime(settings.breakEndMinute);
  form.elements.minimumLeadHours.value = String(Math.round(settings.minimumLeadMinutes / 60));
  form.elements.daysAhead.value = String(settings.daysAhead);
  form.elements.holidays.value = settings.holidays.map((day) => new Date(Number(day) * 86_400_000).toISOString().slice(0, 10)).join("\n");
  document.querySelectorAll('input[name="weekday"]').forEach((item) => { item.checked = settings.workingDays.includes(Number(item.value)); });
}

function renderRetentionState() {
  $("retention-summary").textContent = settings.retentionEnabled
    ? `Política ativa: pedidos encerrados com mais de 60 dias aparecem em lotes de até 100. Última exportação: ${settings.lastExportAt?.toDate ? formatDateTime(settings.lastExportAt, CONFIG.timezone) : "ainda não realizada"}.`
    : "Política desativada. O padrão é 60 dias para pedidos encerrados.";
  $("retention-toggle").textContent = settings.retentionEnabled ? "Desativar política" : "Ativar política de 60 dias";
}

function switchView(name) {
  for (const view of views) $("view-" + view).hidden = view !== name;
  document.querySelectorAll(".admin-tabs button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  if (name === "agenda") loadAgenda(true);
  if (name === "services") loadServices();
  if (name === "finance") loadFinance();
  if (name === "data") loadRetentionBatch();
}

function displayStatus(booking) {
  if (booking.status === "pending" && booking.expiresAt?.toDate?.().getTime() <= Date.now()) return "expired";
  return booking.status;
}

function renderStats() {
  const counts = Object.fromEntries(Object.keys(statusLabels).map((status) => [status, 0]));
  agendaBookings.forEach((booking) => { counts[displayStatus(booking)] += 1; });
  const container = $("stat-cards");
  container.replaceChildren();
  for (const status of Object.keys(statusLabels)) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const label = document.createElement("span");
    label.textContent = statusLabels[status];
    const count = document.createElement("strong");
    count.textContent = String(counts[status] || 0);
    card.append(label, count);
    container.append(card);
  }
}

function renderAgenda() {
  renderStats();
  const container = $("booking-list");
  container.replaceChildren();
  const queryText = $("search-bookings").value.trim().toLowerCase();
  const employeeQuery = $("employee-filter").value.trim().toLowerCase();
  const statusFilter = $("status-filter").value;
  const displayed = agendaBookings.filter((booking) => {
    const status = displayStatus(booking);
    const searchable = `${booking.name} ${booking.phone}`.toLowerCase();
    const employee = String(booking.employeeName || booking.staffName || "").toLowerCase();
    return (statusFilter === "all" || status === statusFilter) && (!queryText || searchable.includes(queryText)) && (!employeeQuery || employee.includes(employeeQuery));
  });
  if (!displayed.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = agendaBookings.length ? "Nenhum pedido corresponde aos filtros." : "Nenhum agendamento neste período.";
    container.append(empty);
  }
  for (const booking of displayed) container.append(createBookingRow(booking));
  $("agenda-count").textContent = `${displayed.length} exibidos · ${agendaBookings.length} carregados nesta janela${agendaHasMore ? " · há mais registros" : ""}`;
  $("load-more").hidden = !agendaHasMore;
}

function addMiniButton(parent, label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-button ${className}`.trim();
  button.textContent = label;
  button.addEventListener("click", action);
  parent.append(button);
  return button;
}

function createBookingRow(booking) {
  const row = document.createElement("article");
  row.className = "booking-row";
  const person = document.createElement("div");
  person.className = "booking-person";
  const personName = document.createElement("strong");
  personName.textContent = booking.name;
  const phone = document.createElement("span");
  phone.textContent = booking.phone;
  person.append(personName, phone);
  const service = document.createElement("div");
  service.className = "booking-service";
  const serviceName = document.createElement("strong");
  serviceName.textContent = booking.serviceName;
  const price = document.createElement("span");
  price.textContent = `${centsToMoney(booking.priceCents)} · ${booking.durationMinutes} min`;
  const assigned = document.createElement("span");
  assigned.textContent = `Profissional: ${booking.employeeName || booking.staffName || "Não informado"}`;
  service.append(serviceName, price, assigned);
  const time = document.createElement("div");
  time.className = "booking-time";
  const timeDate = document.createElement("strong");
  timeDate.textContent = formatDateTime(booking.slotAt, CONFIG.timezone);
  const pill = document.createElement("span");
  const status = displayStatus(booking);
  pill.className = `status-pill status-${status}`;
  pill.textContent = statusLabels[status] || status;
  time.append(timeDate, pill);
  const created = document.createElement("small");
  created.textContent = `Solicitado: ${booking.createdAt?.toDate ? formatDateTime(booking.createdAt, CONFIG.timezone) : "data indisponível"}`;
  time.append(created);
  if (booking.expiresAt && status === "pending") {
    const expiry = document.createElement("small");
    expiry.textContent = `Vence: ${formatDateTime(booking.expiresAt, CONFIG.timezone)}`;
    time.append(expiry);
  }
  const actions = document.createElement("div");
  actions.className = "booking-actions";
  if (status === "pending") {
    addMiniButton(actions, "Aprovar", () => changeBookingStatus(booking.id, "confirmed"));
    addMiniButton(actions, "Recusar", () => changeBookingStatus(booking.id, "refused", true));
  } else if (status === "confirmed") {
    addMiniButton(actions, "Finalizar", () => openPaymentDialog(booking), "mini-button-success");
    addMiniButton(actions, "Não compareceu", () => changeBookingStatus(booking.id, "no_show", true));
    const professional = booking.employeeName || booking.staffName;
    const professionalText = professional ? ` Profissional: ${professional}.` : "";
    const message = `Olá, ${booking.name}! Seu horário no ${CONFIG.studioName} foi confirmado: ${booking.serviceName}, ${formatDateTime(booking.slotAt, CONFIG.timezone)}.${professionalText} Valor: ${centsToMoney(booking.priceCents)}.`;
    let phoneDigits = String(booking.phone).replace(/\D/g, "");
    if (phoneDigits.length === 10 || phoneDigits.length === 11) phoneDigits = `55${phoneDigits}`;
    const link = document.createElement("a");
    link.className = "mini-button";
    link.href = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "WhatsApp";
    actions.append(link);
    addMiniButton(actions, "Cancelar", () => changeBookingStatus(booking.id, "cancelled", true));
  } else {
    actions.append(document.createTextNode("—"));
  }
  addMiniButton(actions, "Excluir", () => deleteBookingManually(booking), "mini-button-danger");
  row.append(person, service, time, actions);
  if (booking.notes) {
    const note = document.createElement("div");
    note.className = "booking-note";
    note.textContent = `Observação: ${booking.notes}`;
    note.style.cssText = "grid-column:1/-1;color:#746d67;font-size:10px;padding-top:7px;border-top:1px solid #eee7e0";
    row.append(note);
  }
  return row;
}

async function loadAgenda(reset = false) {
  if (isLoadingAgenda || !currentUser) return;
  isLoadingAgenda = true;
  $("refresh-agenda").disabled = true;
  $("load-more").disabled = true;
  try {
    const mode = $("range-mode").value;
    const date = $("range-date").value || localDateInputValue(CONFIG.timezone);
    const range = mode === "upcoming" ? null : buildPeriodRange(mode, date, CONFIG.timezone);
    if (reset) {
      agendaBookings = [];
      agendaCursor = null;
      agendaHasMore = false;
    }
    let q = mode === "upcoming"
      ? sdk.query(sdk.collection(db, "bookings"), sdk.where("slotAt", ">=", sdk.Timestamp.now()), sdk.orderBy("slotAt", "asc"), sdk.limit(100))
      : sdk.query(sdk.collection(db, "bookings"),
          sdk.where("slotAt", ">=", sdk.Timestamp.fromDate(range.start)),
          sdk.where("slotAt", "<", sdk.Timestamp.fromDate(range.end)),
          sdk.orderBy("slotAt", "asc"), sdk.limit(100));
    if (agendaCursor && !reset) q = sdk.query(q, sdk.startAfter(agendaCursor));
    const snapshot = await sdk.getDocs(q);
    const batch = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    agendaBookings = reset ? batch : [...agendaBookings, ...batch];
    agendaCursor = snapshot.docs.at(-1) || agendaCursor;
    agendaHasMore = snapshot.size === 100;
    renderAgenda();
  } catch (error) {
    console.error("Falha ao carregar agenda", error);
    setDashboardAlert("Não foi possível carregar a agenda. Confira a conexão, as permissões e os índices do Firestore.");
  } finally {
    isLoadingAgenda = false;
    $("refresh-agenda").disabled = false;
    $("load-more").disabled = false;
  }
}

async function expirePendingBookings() {
  // Consulta apenas pendentes: usa o índice simples de status, sem composto.
  const pending = await sdk.getDocs(sdk.query(sdk.collection(db, "bookings"), sdk.where("status", "==", "pending")));
  const now = Date.now();
  const stale = pending.docs.filter((item) => {
    const expiry = item.data().expiresAt?.toDate?.();
    return expiry instanceof Date && expiry.getTime() <= now;
  });
  let expiredCount = 0;
  for (const item of stale) {
    const bookingRef = item.ref;
    let wasExpired = false;
    await sdk.runTransaction(db, async (transaction) => {
      const fresh = await transaction.get(bookingRef);
      if (!fresh.exists() || fresh.data().status !== "pending" || fresh.data().expiresAt.toDate() > new Date()) return;
      const booking = fresh.data();
      const lockRefs = booking.slotLockIds.map((id) => sdk.doc(db, "slotLocks", id));
      const lockSnapshots = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
      transaction.update(bookingRef, { status: "expired", updatedAt: sdk.serverTimestamp(), decisionAt: sdk.serverTimestamp() });
      lockRefs.forEach((ref, index) => {
        if (lockSnapshots[index].exists() && lockSnapshots[index].data().bookingId === item.id) transaction.delete(ref);
      });
      wasExpired = true;
    });
    if (wasExpired) expiredCount += 1;
  }
  if (expiredCount) setDashboardAlert(`${expiredCount} pedido(s) pendente(s) expiraram e foram liberados ao abrir o painel.`);
}
function openPaymentDialog(booking) {
  const form = $("payment-form");
  form.elements.bookingId.value = booking.id;
  form.elements.receivedAmount.value = (booking.priceCents / 100).toFixed(2);
  form.elements.paymentMethod.value = "pix";
  $("payment-booking-summary").textContent = `${booking.name} · ${booking.serviceName} · valor previsto ${centsToMoney(booking.priceCents)}`;
  $("payment-status").textContent = "";
  $("payment-dialog").showModal();
}

async function changeBookingStatus(id, nextStatus, ask = false, extra = {}) {
  const bookingRef = sdk.doc(db, "bookings", id);
  const labels = { confirmed: "aprovar", refused: "recusar", cancelled: "cancelar", no_show: "marcar como não compareceu", completed: "finalizar" };
  if (ask && !window.confirm(`Confirma ${labels[nextStatus] || "alterar"} este pedido?`)) return false;
  try {
    await sdk.runTransaction(db, async (transaction) => {
      const bookingSnapshot = await transaction.get(bookingRef);
      if (!bookingSnapshot.exists()) throw new Error("Este pedido não existe mais.");
      const booking = bookingSnapshot.data();
      const lockRefs = booking.slotLockIds.map((lockId) => sdk.doc(db, "slotLocks", lockId));
      const lockSnapshots = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
      if (booking.status === "pending" && booking.expiresAt.toDate() <= new Date() && nextStatus !== "expired") throw new Error("Este pedido já expirou. Atualize a agenda.");
      const allowed = (booking.status === "pending" && ["confirmed", "refused", "expired", "cancelled"].includes(nextStatus)) ||
        (booking.status === "confirmed" && ["cancelled", "completed", "no_show"].includes(nextStatus));
      if (!allowed) throw new Error("Esta alteração de status não é permitida.");
      const update = { status: nextStatus, updatedAt: sdk.serverTimestamp(), decisionAt: sdk.serverTimestamp() };
      if (nextStatus === "completed") Object.assign(update, {
        receivedCents: extra.receivedCents,
        paymentMethod: extra.paymentMethod,
        completedAt: sdk.serverTimestamp(),
        paymentAt: extra.receivedCents > 0 ? sdk.serverTimestamp() : null,
      });
      if (nextStatus === "no_show") Object.assign(update, { receivedCents: 0, paymentMethod: "none", completedAt: sdk.serverTimestamp(), paymentAt: null });
      transaction.update(bookingRef, update);
      lockRefs.forEach((ref, index) => {
        if (!lockSnapshots[index].exists() || lockSnapshots[index].data().bookingId !== id) return;
        if (nextStatus === "confirmed") transaction.update(ref, { status: "confirmed", expiresAt: null });
        else transaction.delete(ref);
      });
    });
    setDashboardAlert(nextStatus === "confirmed" ? "Pedido confirmado. Use o botão WhatsApp para enviar a mensagem de confirmação." : `Pedido ${statusLabels[nextStatus].toLowerCase()}.`);
    await loadAgenda(true);
    await loadRetentionBatch();
    await loadFinance();
    return true;
  } catch (error) {
    console.error("Falha ao atualizar pedido", error);
    setDashboardAlert(error.message || "Não foi possível atualizar o pedido. Atualize a agenda e tente novamente.");
    return false;
  }
}

async function deleteBookingManually(booking) {
  if (!window.confirm(`Excluir permanentemente o pedido de ${booking.name} para ${booking.serviceName}? Esta ação remove o registro e não pode ser desfeita. Para apenas liberar o horário, use Recusar ou Cancelar.`)) return;
  const ref = sdk.doc(db, "bookings", booking.id);
  try {
    await sdk.runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return;
      const current = snapshot.data();
      const locks = (current.slotLockIds || []).map((id) => sdk.doc(db, "slotLocks", id));
      const lockSnaps = await Promise.all(locks.map((lock) => transaction.get(lock)));
      if (["pending", "confirmed"].includes(current.status)) {
        transaction.update(ref, { status: "cancelled", updatedAt: sdk.serverTimestamp(), decisionAt: sdk.serverTimestamp() });
        locks.forEach((lock, index) => {
          if (lockSnaps[index].exists() && lockSnaps[index].data().bookingId === booking.id) transaction.delete(lock);
        });
      }
    });
    await sdk.deleteDoc(ref);
    setDashboardAlert("Reserva excluída permanentemente.");
    await loadAgenda(true);
    await loadRetentionBatch();
    await loadFinance();
  } catch (error) {
    console.error("Falha ao excluir reserva", error);
    setDashboardAlert(error.message || "Não foi possível excluir a reserva.");
  }
}

async function completeBooking(event) {
  event.preventDefault();
  const form = $("payment-form");
  if (!form.reportValidity()) return;
  const booking = agendaBookings.find((item) => item.id === form.elements.bookingId.value);
  if (!booking) { setStatus("payment-status", "Atualize a agenda e tente novamente.", true); return; }
  const receivedCents = Math.round(Number(form.elements.receivedAmount.value) * 100);
  const paymentMethod = form.elements.paymentMethod.value;
  if (!Number.isInteger(receivedCents) || receivedCents < 0 || receivedCents > booking.priceCents) {
    setStatus("payment-status", "O valor recebido deve ficar entre R$ 0,00 e o valor previsto.", true); return;
  }
  if (receivedCents > 0 && paymentMethod === "none") {
    setStatus("payment-status", "Selecione a forma de pagamento do valor recebido.", true); return;
  }
  const succeeded = await changeBookingStatus(booking.id, "completed", false, { receivedCents, paymentMethod: receivedCents ? paymentMethod : "none" });
  if (succeeded) { $("payment-dialog").close(); await loadFinance(); }
}
async function loadServices() {
  if (!currentUser) return;
  const container = $("admin-service-list");
  container.replaceChildren();
  try {
    const snapshot = await sdk.getDocs(sdk.query(sdk.collection(db, "services"), sdk.orderBy("name"), sdk.limit(100)));
    services = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    if (!services.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Nenhum serviço cadastrado. Use “Adicionar serviço” ou crie um catálogo de exemplo para testar.";
      container.append(empty);
    }
    services.forEach((service) => container.append(createAdminServiceCard(service)));
  } catch (error) {
    console.error("Falha ao carregar serviços", error);
    setDashboardAlert("Não foi possível carregar o catálogo. Confira as permissões e a conexão.");
  }
}

function createAdminServiceCard(service) {
  const card = document.createElement("article");
  card.className = "admin-service";
  const text = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = service.name;
  const desc = document.createElement("p");
  desc.textContent = service.description;
  const meta = document.createElement("div");
  meta.className = "service-admin-meta";
  const price = currentPrice(service);
  meta.textContent = `${centsToMoney(price.cents)}${price.promo ? ` (oferta; normal ${centsToMoney(service.basePriceCents)})` : ""} · ${service.durationMinutes} min · ${service.active ? "Ativo" : "Oculto"}`;
  text.append(title, desc, meta);
  const actions = document.createElement("div");
  actions.className = "admin-service-actions";
  addMiniButton(actions, "Editar", () => openServiceDialog(service));
  addMiniButton(actions, service.active ? "Ocultar" : "Ativar", () => toggleService(service));
  addMiniButton(actions, "Excluir", () => deleteService(service), "danger");
  card.append(text, actions);
  return card;
}

function openServiceDialog(service = null) {
  const form = $("service-form");
  form.reset();
  form.elements.id.value = service?.id || "";
  form.elements.name.value = service?.name || "";
  form.elements.description.value = service?.description || "";
  form.elements.durationMinutes.value = String(service?.durationMinutes || 60);
  form.elements.basePrice.value = service ? (service.basePriceCents / 100).toFixed(2) : "";
  form.elements.promoPrice.value = Number.isInteger(service?.promoPriceCents) ? (service.promoPriceCents / 100).toFixed(2) : "";
  form.elements.promoStart.value = service?.promoStartsAt?.toDate ? localDateInputValue(CONFIG.timezone, service.promoStartsAt.toDate()) : "";
  form.elements.promoEnd.value = service?.promoEndsAt?.toDate ? localDateInputValue(CONFIG.timezone, new Date(service.promoEndsAt.toDate().getTime() - 60_000)) : "";
  form.elements.active.checked = service?.active ?? true;
  $("service-dialog-title").textContent = service ? "Editar serviço" : "Novo serviço";
  $("service-status").textContent = "";
  $("service-dialog").showModal();
}

async function saveService(event) {
  event.preventDefault();
  const form = $("service-form");
  if (!form.reportValidity()) return;
  const id = form.elements.id.value;
  const name = form.elements.name.value.trim();
  const description = form.elements.description.value.trim();
  const basePriceCents = moneyToCents(form.elements.basePrice.value);
  let promoPriceCents = null;
  let promoStartsAt = null;
  let promoEndsAt = null;
  const promoValue = form.elements.promoPrice.value;
  const startValue = form.elements.promoStart.value;
  const endValue = form.elements.promoEnd.value;
  if (promoValue || startValue || endValue) {
    if (!promoValue || !startValue || !endValue) throw new Error("Preencha o preço e as duas datas da promoção.");
    promoPriceCents = moneyToCents(promoValue);
    if (promoPriceCents >= basePriceCents) throw new Error("O preço promocional precisa ser menor que o preço normal.");
    if (endValue < startValue) throw new Error("A data final da promoção precisa ser igual ou posterior à inicial.");
    promoStartsAt = sdk.Timestamp.fromDate(zonedDateTimeToUtc(startValue, "00:00", CONFIG.timezone));
    promoEndsAt = sdk.Timestamp.fromDate(zonedDateTimeToUtc(addCalendarDays(endValue, 1), "00:00", CONFIG.timezone));
  }
  const existing = services.find((service) => service.id === id);
  const serviceData = {
    name,
    description,
    durationMinutes: Number(form.elements.durationMinutes.value),
    basePriceCents,
    promoPriceCents,
    promoStartsAt,
    promoEndsAt,
    active: form.elements.active.checked,
    createdAt: existing?.createdAt || sdk.serverTimestamp(),
    updatedAt: sdk.serverTimestamp(),
  };
  const ref = id ? sdk.doc(db, "services", id) : sdk.doc(sdk.collection(db, "services"));
  if (id) await sdk.updateDoc(ref, serviceData);
  else await sdk.setDoc(ref, serviceData);
  $("service-dialog").close();
  await loadServices();
  setDashboardAlert("Serviço salvo.");
}

async function toggleService(service) {
  try {
    const { id, ...serviceData } = service;
    await sdk.updateDoc(sdk.doc(db, "services", id), { ...serviceData, active: !service.active, updatedAt: sdk.serverTimestamp() });
    await loadServices();
  } catch (error) {
    setDashboardAlert(error.message || "Não foi possível alterar a visibilidade do serviço.");
  }
}

async function deleteService(service) {
  if (!window.confirm(`Excluir o serviço “${service.name}”? Pedidos anteriores continuam com o registro do valor e do serviço.`)) return;
  try {
    await sdk.deleteDoc(sdk.doc(db, "services", service.id));
    await loadServices();
    setDashboardAlert("Serviço excluído.");
  } catch (error) {
    setDashboardAlert(error.message || "Não foi possível excluir o serviço.");
  }
}

async function createSampleServices() {
  if (!window.confirm("Criar os quatro serviços com valores e durações iniciais de referência? Eles ficarão ativos e visíveis no site. Você poderá editar valores, duração e descrição no painel.")) return;
  const now = sdk.serverTimestamp();
  const examples = [
    { name: "Atendimento Social", description: "Valor e duração iniciais de referência. Edite as informações no painel conforme necessário.", durationMinutes: 60, basePriceCents: 12000, promoPriceCents: null, promoStartsAt: null, promoEndsAt: null, active: true, createdAt: now, updatedAt: now },
    { name: "Noiva Civil", description: "Valor e duração iniciais de referência. Edite as informações no painel conforme necessário.", durationMinutes: 90, basePriceCents: 25000, promoPriceCents: null, promoStartsAt: null, promoEndsAt: null, active: true, createdAt: now, updatedAt: now },
    { name: "Dia da Noiva", description: "Valor e duração iniciais de referência. Edite as informações no painel conforme necessário.", durationMinutes: 120, basePriceCents: 60000, promoPriceCents: null, promoStartsAt: null, promoEndsAt: null, active: true, createdAt: now, updatedAt: now },
    { name: "Curso Auto Maquiagem", description: "Valor e duração iniciais de referência. Edite as informações no painel conforme necessário.", durationMinutes: 120, basePriceCents: 20000, promoPriceCents: null, promoStartsAt: null, promoEndsAt: null, active: true, createdAt: now, updatedAt: now },
  ];
  const batch = sdk.writeBatch(db);
  examples.forEach((service) => batch.set(sdk.doc(sdk.collection(db, "services")), service));
  try {
    await batch.commit();
    await loadServices();
    setDashboardAlert("Serviços iniciais criados e publicados. Revise valores, durações e descrições no catálogo.");
  } catch (error) {
    setDashboardAlert(error.message || "Não foi possível criar os serviços iniciais.");
  }
}

async function saveSchedule(event) {
  event.preventDefault();
  const form = $("schedule-form");
  if (!form.reportValidity()) return;
  try {
    const next = formSchedule();
    if (!next.workingDays.length) throw new Error("Selecione ao menos um dia de atendimento.");
    if (next.closeMinute <= next.openMinute) throw new Error("O horário de fechamento deve ser depois da abertura.");
    if ((next.breakStartMinute < 0) !== (next.breakEndMinute < 0)) throw new Error("Preencha o início e o fim do intervalo, ou deixe ambos vazios.");
    if (next.breakStartMinute >= 0 && (next.breakStartMinute % 30 || next.breakEndMinute % 30)) throw new Error("O intervalo precisa começar e terminar em blocos de 30 minutos.");
    if (next.openMinute % 30 || next.closeMinute % 30) throw new Error("A abertura e o fechamento precisam coincidir com blocos de 30 minutos.");
    if (next.holidays.length > 120) throw new Error("Cadastre até 120 datas de folga por vez.");
    await sdk.setDoc(sdk.doc(db, "settings", "public"), publicSchedulePayload(next));
    mergeSettings(next, settings);
    setStatus("schedule-status", "Expediente salvo. O site público já pode receber pedidos.");
    setDashboardAlert("Expediente publicado para os visitantes.");
  } catch (error) {
    setStatus("schedule-status", error.message || "Não foi possível salvar o expediente.", true);
  }
}

function downloadCsv(filename, rows) {
  const blob = new Blob([makeCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bookingCsvRows(bookings) {
  return [
    ["Nome", "Telefone", "Serviço", "Profissional", "Duração (min)", "Valor registrado (R$)", "Recebido (R$)", "Data e hora", "Status", "Observações", "Solicitado em"],
    ...bookings.map((booking) => [
      booking.name, booking.phone, booking.serviceName, booking.employeeName || booking.staffName || "", booking.durationMinutes,
      (booking.priceCents / 100).toFixed(2).replace(".", ","), (Number(booking.receivedCents || 0) / 100).toFixed(2).replace(".", ","),
      formatDateTime(booking.slotAt, CONFIG.timezone), statusLabels[displayStatus(booking)], booking.notes || "", formatDateTime(booking.createdAt, CONFIG.timezone),
    ]),
  ];
}
function exportCurrentAgenda() {
  if (!agendaBookings.length) {
    setDashboardAlert("Não há reservas carregadas para exportar. Abra a agenda e selecione um período.");
    return;
  }
  downloadCsv(`agenda-studio-${localDateInputValue(CONFIG.timezone)}.csv`, bookingCsvRows(agendaBookings));
  setDashboardAlert(`CSV exportado com ${agendaBookings.length} reserva(s) carregada(s). Use a impressão do navegador para salvar em PDF.`);
}

function addFinanceStat(container, label, value, note = "") {
  const card = document.createElement("div");
  card.className = "stat-card";
  const title = document.createElement("span"); title.textContent = label;
  const amount = document.createElement("strong"); amount.textContent = value;
  card.append(title, amount);
  if (note) { const detail = document.createElement("small"); detail.textContent = note; card.append(detail); }
  container.append(card);
}

async function loadFinance() {
  if (!currentUser) return;
  const monthInput = $("finance-month");
  if (!monthInput.value) monthInput.value = localDateInputValue(CONFIG.timezone).slice(0, 7);
  const first = `${monthInput.value}-01`;
  const range = buildPeriodRange("month", first, CONFIG.timezone);
  const start = sdk.Timestamp.fromDate(range.start), end = sdk.Timestamp.fromDate(range.end);
  try {
    const bookingQuery = sdk.query(sdk.collection(db, "bookings"), sdk.where("slotAt", ">=", start), sdk.where("slotAt", "<", end), sdk.orderBy("slotAt", "asc"), sdk.limit(500));
    const paymentQuery = sdk.query(sdk.collection(db, "bookings"), sdk.where("paymentAt", ">=", start), sdk.where("paymentAt", "<", end), sdk.orderBy("paymentAt", "asc"), sdk.limit(500));
    const expenseQuery = sdk.query(sdk.collection(db, "expenses"), sdk.where("occurredAt", ">=", start), sdk.where("occurredAt", "<", end), sdk.orderBy("occurredAt", "asc"), sdk.limit(500));
    const [bookingSnapshot, paymentSnapshot, expenseSnapshot] = await Promise.all([sdk.getDocs(bookingQuery), sdk.getDocs(paymentQuery), sdk.getDocs(expenseQuery)]);
    const bookings = bookingSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    const receipts = paymentSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    const expenses = expenseSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    financeReceipts = receipts;
    financeExpenses = expenses;
    const summary = summarizeFinance(bookings, expenses, receipts);
    const stats = $("finance-stats"); stats.replaceChildren();
    addFinanceStat(stats, "Recebido", centsToMoney(summary.receivedCents), `${summary.completedCount} atendimento(s) finalizado(s)`);
    addFinanceStat(stats, "Despesas", centsToMoney(summary.expenseCents), `${summary.expenseCount} lançamento(s)`);
    addFinanceStat(stats, "Saldo operacional", centsToMoney(summary.balanceCents));
    addFinanceStat(stats, "A receber", centsToMoney(summary.receivableCents), "Atendimentos finalizados com saldo em aberto");
    addFinanceStat(stats, "Não compareceu", String(summary.noShowCount));
    renderExpenseList(expenses);
    if (bookingSnapshot.size === 500 || paymentSnapshot.size === 500 || expenseSnapshot.size === 500) setDashboardAlert("O financeiro mostra até 500 reservas, recebimentos e despesas neste mês. Exporte os dados se precisar de um fechamento maior.");
  } catch (error) {
    console.error("Falha ao carregar financeiro", error);
    setDashboardAlert("Não foi possível carregar o financeiro. Confira conexão, permissões e índices Firestore.");
  }
}

function exportFinanceCsv() {
  const rows = [["Tipo", "Data", "Descrição", "Categoria / forma", "Cliente", "Serviço", "Valor (R$)"]];
  financeReceipts.forEach((item) => rows.push(["Recebimento", formatDateTime(item.paymentAt, CONFIG.timezone), "Atendimento", item.paymentMethod || "", item.name || "", item.serviceName || "", (Number(item.receivedCents || 0) / 100).toFixed(2).replace(".", ",")]));
  financeExpenses.forEach((item) => rows.push(["Despesa", formatDateTime(item.occurredAt, CONFIG.timezone), item.description, item.category, "", "", (-Number(item.amountCents || 0) / 100).toFixed(2).replace(".", ",")]));
  if (rows.length === 1) { setDashboardAlert("Não há recebimentos ou despesas neste mês para exportar."); return; }
  downloadCsv(`financeiro-${$("finance-month").value}.csv`, rows);
}
function renderExpenseList(expenses) {
  const list = $("expense-list"); list.replaceChildren();
  if (!expenses.length) { const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "Nenhuma despesa cadastrada neste mês."; list.append(empty); return; }
  for (const expense of expenses) {
    const row = document.createElement("article"); row.className = "booking-row";
    const desc = document.createElement("div"); desc.className = "booking-person";
    const title = document.createElement("strong"); title.textContent = expense.description;
    const category = document.createElement("span"); category.textContent = expense.category;
    desc.append(title, category);
    const date = document.createElement("div"); date.className = "booking-time"; date.textContent = formatDateTime(expense.occurredAt, CONFIG.timezone);
    const amount = document.createElement("strong"); amount.textContent = `− ${centsToMoney(expense.amountCents)}`;
    const actions = document.createElement("div"); actions.className = "booking-actions";
    addMiniButton(actions, "Excluir", () => deleteExpense(expense));
    row.append(desc, date, amount, actions); list.append(row);
  }
}

async function saveExpense(event) {
  event.preventDefault();
  const form = $("expense-form");
  if (!form.reportValidity()) return;
  try {
    const data = {
      occurredAt: sdk.Timestamp.fromDate(zonedDateTimeToUtc(form.elements.occurredOn.value, "12:00", CONFIG.timezone)),
      amountCents: moneyToCents(form.elements.amount.value),
      category: form.elements.category.value,
      description: form.elements.description.value.trim(),
      createdAt: sdk.serverTimestamp(), updatedAt: sdk.serverTimestamp(),
    };
    if (data.description.length < 2) throw new Error("Descreva a despesa.");
    await sdk.setDoc(sdk.doc(sdk.collection(db, "expenses")), data);
    form.reset(); form.elements.occurredOn.value = localDateInputValue(CONFIG.timezone);
    setStatus("expense-status", "Despesa registrada.");
    await loadFinance();
  } catch (error) { console.error("Falha ao salvar despesa", error); setStatus("expense-status", error.message || "Não foi possível salvar a despesa.", true); }
}

async function deleteExpense(expense) {
  if (!window.confirm(`Excluir a despesa “${expense.description}” de ${centsToMoney(expense.amountCents)}?`)) return;
  try { await sdk.deleteDoc(sdk.doc(db, "expenses", expense.id)); await loadFinance(); }
  catch (error) { setDashboardAlert(error.message || "Não foi possível excluir a despesa."); }
}
async function fetchRetentionCandidates(cutoff, batchSize) {
  const found = [];
  let cursor = null;
  while (found.length < batchSize) {
    const constraints = [sdk.where("status", "in", terminalStatuses), sdk.limit(100)];
    if (cursor) constraints.push(sdk.startAfter(cursor));
    const snapshot = await sdk.getDocs(sdk.query(sdk.collection(db, "bookings"), ...constraints));
    found.push(...snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((booking) => eligibleForRetention(booking, cutoff)));
    if (snapshot.size < 100) break;
    cursor = snapshot.docs.at(-1);
  }
  return found.sort((a, b) => a.slotAt.toMillis() - b.slotAt.toMillis()).slice(0, batchSize);
}
async function loadRetentionBatch() {
  if (!currentUser || !settings.retentionEnabled) {
    $("retention-batch").hidden = true;
    return;
  }
  try {
    const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
    retentionCandidates = await fetchRetentionCandidates(cutoff, 100);
    $("retention-batch").hidden = !retentionCandidates.length;
    retentionExportedIds = [];
    $("delete-old").disabled = true;
    if (retentionCandidates.length) {
      $("retention-batch-copy").textContent = `${retentionCandidates.length} pedido(s) encerrado(s) podem ser exportados neste lote. O limite é 100 por vez. Nenhum pedido pendente, confirmado ou futuro entra na lista.`;
      const recorded = settings.lastExportIds || [];
      const exportDate = settings.lastExportAt?.toDate?.();
      const recent = exportDate && Date.now() - exportDate.getTime() < 24 * 60 * 60_000;
      if (recent && retentionCandidates.every((item) => recorded.includes(item.id))) {
        retentionExportedIds = retentionCandidates.map((item) => item.id);
        $("delete-old").disabled = false;
        setStatus("retention-status", "Este lote já foi exportado. Confira o CSV antes de confirmar a exclusão.");
      } else {
        setStatus("retention-status", "Exporte este lote antes de liberar a exclusão.");
      }
    }
  } catch (error) {
    console.error("Falha ao consultar retenção", error);
    $("retention-batch").hidden = false;
    $("retention-batch-copy").textContent = "Não foi possível buscar os registros elegíveis. Confira a conexão e o índice do Firestore.";
    setStatus("retention-status", error.message || "Falha ao buscar registros.", true);
  }
}

async function exportOldRecords() {
  if (!retentionCandidates.length) return;
  downloadCsv(`reservas-antigas-${localDateInputValue(CONFIG.timezone)}.csv`, bookingCsvRows(retentionCandidates));
  const ids = retentionCandidates.map((item) => item.id);
  try {
    const next = { ...settings, lastExportAt: sdk.serverTimestamp(), lastExportIds: ids };
    const maintenanceRef = sdk.doc(db, "settings", "admin");
    await sdk.setDoc(maintenanceRef, maintenancePayload(next));
    const refreshed = await sdk.getDoc(maintenanceRef);
    mergeSettings(settings, refreshed.data());
    retentionExportedIds = ids;
    $("delete-old").disabled = false;
    setStatus("retention-status", `CSV gerado e registrado com ${ids.length} pedido(s). Confirme a exclusão somente depois de guardar o arquivo.`);
  } catch (error) {
    setStatus("retention-status", error.message || "O CSV foi gerado, mas não foi possível registrar a exportação. A exclusão continua bloqueada.", true);
  }
}

async function deleteExportedBatch() {
  const ids = retentionExportedIds;
  if (!ids.length || ids.length > 100) return;
  if (!window.confirm(`Excluir permanentemente os ${ids.length} pedidos deste lote? Esta ação não pode ser desfeita. Confira se o CSV foi salvo.`)) return;
  try {
    const refs = ids.map((id) => sdk.doc(db, "bookings", id));
    await sdk.runTransaction(db, async (transaction) => {
      const settingsRef = sdk.doc(db, "settings", "admin");
      const [settingsSnapshot, ...bookingSnapshots] = await Promise.all([settingsRef, ...refs].map((ref) => transaction.get(ref)));
      const storedIds = settingsSnapshot.data()?.lastExportIds || [];
      const exportAt = settingsSnapshot.data()?.lastExportAt?.toDate?.();
      if (!exportAt || Date.now() - exportAt.getTime() >= 24 * 60 * 60_000 || !ids.every((id) => storedIds.includes(id))) {
        throw new Error("A exportação registrada expirou ou não corresponde a este lote. Exporte novamente.");
      }
      const cutoff = Date.now() - settings.retentionDays * 86_400_000;
      let deleted = 0;
      bookingSnapshots.forEach((snapshot, index) => {
        if (!snapshot.exists()) return;
        if (!eligibleForRetention(snapshot.data(), new Date(cutoff))) throw new Error("Um registro deixou de atender à política de retenção. Atualize e exporte novamente.");
        transaction.delete(refs[index]);
        deleted += 1;
      });
      transaction.update(settingsRef, {
        lastExportIds: [],
        lastCleanupAt: sdk.serverTimestamp(),
        lastCleanupCount: deleted,
      });
    });
    setStatus("retention-status", `${ids.length} registro(s) do lote foram removidos depois da exportação e confirmação.`);
    retentionExportedIds = [];
    await loadRetentionBatch();
    const refreshed = await sdk.getDoc(sdk.doc(db, "settings", "admin"));
    mergeSettings(settings, refreshed.data());
  } catch (error) {
    setStatus("retention-status", error.message || "Não foi possível excluir o lote.", true);
  }
}

async function toggleRetention() {
  const activating = !settings.retentionEnabled;
  const confirmation = activating
    ? "Ativar a política de 60 dias? Ela só lista reservas recusadas, expiradas ou canceladas quando o painel é aberto. Cada lote exige CSV e confirmação antes da exclusão."
    : "Desativar a política de retenção? Nenhum lote será removido enquanto ela estiver desativada.";
  if (!window.confirm(confirmation)) return;
  try {
    const next = { ...settings, retentionEnabled: activating, lastExportIds: [] };
    await sdk.setDoc(sdk.doc(db, "settings", "admin"), maintenancePayload(next));
    const refreshed = await sdk.getDoc(sdk.doc(db, "settings", "admin"));
    mergeSettings(settings, refreshed.data());
    await loadRetentionBatch();
    setStatus("retention-status", activating ? "Política ativada. A limpeza só ocorrerá após exportar e confirmar cada lote." : "Política desativada.");
  } catch (error) {
    setStatus("retention-status", error.message || "Não foi possível alterar a política.", true);
  }
}

async function loadAdminData() {
  setDashboardAlert("");
  try {
    const [settingsSnapshot, maintenanceSnapshot] = await Promise.all([
      sdk.getDoc(sdk.doc(db, "settings", "public")),
      sdk.getDoc(sdk.doc(db, "settings", "admin")),
    ]);
    mergeSettings(
      settingsSnapshot.exists() ? settingsSnapshot.data() : DEFAULT_SCHEDULE,
      maintenanceSnapshot.exists() ? maintenanceSnapshot.data() : {},
    );
    try {
      await expirePendingBookings();
    } catch (cleanupError) {
      console.error("Falha ao liberar pedidos vencidos; a agenda continuará disponível", cleanupError);
      setDashboardAlert("A agenda abriu, mas a liberação automática de pedidos vencidos falhou. Confira os índices do Firestore no Console.");
    }
    await loadAgenda(true);
    await loadRetentionBatch();
  } catch (error) {
    console.error("Falha ao abrir painel", error);
    setDashboardAlert("Não foi possível abrir os dados do painel. Confira se o UID desta conta está autorizado nas regras Firestore.");
  }
}

function showUser(user) {
  currentUser = user;
  loginPanel.hidden = Boolean(user);
  dashboard.hidden = !user;
  if (!user) return;
  $("admin-email").textContent = user.email || "Conta administrativa";
  void loadAdminData();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setStatus("login-status", "Entrando…");
  try {
    await sdk.signInWithEmailAndPassword(auth, form.elements.email.value.trim(), form.elements.password.value);
  } catch (error) {
    setStatus("login-status", error.code === "auth/invalid-credential" ? "E-mail ou senha incorretos." : "Não foi possível entrar. Confira a conta e a conexão.", true);
  } finally {
    button.disabled = false;
  }
});

$("logout-button").addEventListener("click", () => sdk.signOut(auth));
document.querySelectorAll(".admin-tabs button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("refresh-agenda").addEventListener("click", () => loadAgenda(true));
$("load-more").addEventListener("click", () => loadAgenda(false));
$("range-mode").addEventListener("change", () => loadAgenda(true));
$("range-date").addEventListener("change", () => loadAgenda(true));
$("search-bookings").addEventListener("input", renderAgenda);
$("status-filter").addEventListener("change", renderAgenda);
$("employee-filter").addEventListener("input", renderAgenda);
$("new-service").addEventListener("click", () => services.length ? openServiceDialog() : openServiceDialog());
$("service-dialog").querySelector(".dialog-close").addEventListener("click", () => $("service-dialog").close());
$("service-form").addEventListener("submit", (event) => {
  if ($("service-form").querySelector("button[value=cancel]") === document.activeElement) return;
  event.preventDefault();
  saveService(event).catch((error) => setStatus("service-status", error.message, true));
});
$("schedule-form").addEventListener("submit", saveSchedule);
$("payment-dialog").querySelector(".dialog-close").addEventListener("click", () => $("payment-dialog").close());
$("payment-form").addEventListener("submit", (event) => { if ($("payment-form").querySelector("button[value=cancel]") === document.activeElement) return; completeBooking(event).catch((error) => setStatus("payment-status", error.message || "Falha ao finalizar.", true)); });
$("expense-form").addEventListener("submit", saveExpense);
$("finance-month").addEventListener("change", loadFinance);
$("refresh-finance").addEventListener("click", loadFinance);
$("export-finance").addEventListener("click", exportFinanceCsv);
$("expense-form").elements.occurredOn.value = localDateInputValue(CONFIG.timezone);
$("export-current").addEventListener("click", exportCurrentAgenda);
$("print-current").addEventListener("click", () => window.print());
$("retention-toggle").addEventListener("click", toggleRetention);
$("export-old").addEventListener("click", exportOldRecords);
$("delete-old").addEventListener("click", deleteExportedBatch);


// Catálogo de exemplo fica acessível no estado vazio, sem publicar dados ilustrativos.
const serviceEmptyObserver = new MutationObserver(() => {
  const empty = $("admin-service-list").querySelector(".empty-state");
  if (empty && !empty.querySelector("button")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-outline";
    button.textContent = "Criar catálogo de exemplo";
    button.addEventListener("click", createSampleServices);
    empty.append(document.createElement("br"), document.createElement("br"), button);
  }
});
serviceEmptyObserver.observe($("admin-service-list"), { childList: true });

$("range-date").value = localDateInputValue(CONFIG.timezone);

if (!firebaseReady) {
  setupNotice.hidden = false;
  setupNotice.innerHTML = "<strong>Firebase ainda não configurado</strong>Preencha a configuração do app e aplique as regras antes de usar a área administrativa. Veja o passo a passo no README.";
  loginPanel.hidden = true;
} else {
  sdk.onAuthStateChanged(auth, (user) => {
    if (user && !CONFIG.authorizedAdminUids.includes(user.uid)) {
      setStatus("login-status", "Esta conta não está autorizada para administrar o studio.", true);
      sdk.signOut(auth);
      showUser(null);
      return;
    }
    showUser(user);
  });
}

