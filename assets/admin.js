import { CONFIG, DEFAULT_SCHEDULE } from "./config.js";
import {
  STATUS_LABELS, addCalendarDays, buildPeriodRange, centsToMoney, currentPrice, eligibleForRetention,
  epochDay, formatDateTime, getSlotLockIds, localDateInputValue, makeCsv, moneyToCents,
  zonedDateTimeToUtc,
} from "./domain.js";
import { auth, db, firebaseReady, sdk } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const loginPanel = $("login-panel");
const dashboard = $("dashboard");
const setupNotice = $("setup-notice");
const views = ["agenda", "services", "schedule", "data"];
const statusLabels = STATUS_LABELS;
const terminalStatuses = ["refused", "expired", "cancelled"];
let currentUser = null;
let settings = { ...DEFAULT_SCHEDULE, lastExportAt: null, lastExportIds: [], lastCleanupAt: null, lastCleanupCount: 0 };
let services = [];
let agendaBookings = [];
let agendaCursor = null;
let agendaHasMore = false;
let retentionCandidates = [];
let retentionExportedIds = [];
let isLoadingAgenda = false;

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
  const statusFilter = $("status-filter").value;
  const displayed = agendaBookings.filter((booking) => {
    const status = displayStatus(booking);
    const searchable = `${booking.name} ${booking.phone}`.toLowerCase();
    return (statusFilter === "all" || status === statusFilter) && (!queryText || searchable.includes(queryText));
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
  service.append(serviceName, price);
  const time = document.createElement("div");
  time.className = "booking-time";
  const timeDate = document.createElement("strong");
  timeDate.textContent = formatDateTime(booking.slotAt, CONFIG.timezone);
  const pill = document.createElement("span");
  const status = displayStatus(booking);
  pill.className = `status-pill status-${status}`;
  pill.textContent = statusLabels[status] || status;
  time.append(timeDate, pill);
  const actions = document.createElement("div");
  actions.className = "booking-actions";
  if (status === "pending") {
    addMiniButton(actions, "Aprovar", () => changeBookingStatus(booking.id, "confirmed"));
    addMiniButton(actions, "Recusar", () => changeBookingStatus(booking.id, "refused", true));
  } else if (status === "confirmed") {
    const message = `Olá, ${booking.name}! Seu horário no ${CONFIG.studioName} foi confirmado: ${booking.serviceName}, ${formatDateTime(booking.slotAt, CONFIG.timezone)}. Valor: ${centsToMoney(booking.priceCents)}.`;
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
    const range = buildPeriodRange(mode, date, CONFIG.timezone);
    if (reset) {
      agendaBookings = [];
      agendaCursor = null;
      agendaHasMore = false;
    }
    let q = sdk.query(sdk.collection(db, "bookings"),
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
  const now = sdk.Timestamp.now();
  const q = sdk.query(sdk.collection(db, "bookings"),
    sdk.where("status", "==", "pending"), sdk.where("expiresAt", "<=", now),
    sdk.orderBy("expiresAt"), sdk.limit(100));
  const stale = await sdk.getDocs(q);
  let expiredCount = 0;
  for (const item of stale.docs) {
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

async function changeBookingStatus(id, nextStatus, ask = false) {
  const bookingRef = sdk.doc(db, "bookings", id);
  const labels = { confirmed: "aprovar", refused: "recusar", cancelled: "cancelar" };
  if (ask && !window.confirm(`Confirma ${labels[nextStatus] || "alterar"} este pedido?`)) return;
  try {
    await sdk.runTransaction(db, async (transaction) => {
      const bookingSnapshot = await transaction.get(bookingRef);
      if (!bookingSnapshot.exists()) throw new Error("Este pedido não existe mais.");
      const booking = bookingSnapshot.data();
      const lockRefs = booking.slotLockIds.map((lockId) => sdk.doc(db, "slotLocks", lockId));
      const lockSnapshots = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
      if (booking.status === "pending" && booking.expiresAt.toDate() <= new Date()) throw new Error("Este pedido já expirou. Atualize a agenda.");
      if (nextStatus === "confirmed" && booking.status !== "pending") throw new Error("Somente pedidos pendentes podem ser aprovados.");
      if (nextStatus === "refused" && booking.status !== "pending") throw new Error("Somente pedidos pendentes podem ser recusados.");
      if (nextStatus === "cancelled" && booking.status !== "confirmed") throw new Error("Somente pedidos confirmados podem ser cancelados.");
      transaction.update(bookingRef, { status: nextStatus, updatedAt: sdk.serverTimestamp(), decisionAt: sdk.serverTimestamp() });
      lockRefs.forEach((ref, index) => {
        if (!lockSnapshots[index].exists() || lockSnapshots[index].data().bookingId !== id) return;
        if (nextStatus === "confirmed") transaction.update(ref, { status: "confirmed", expiresAt: null });
        else transaction.delete(ref);
      });
    });
    setDashboardAlert(nextStatus === "confirmed" ? "Pedido confirmado. Use o botão WhatsApp para enviar a mensagem de confirmação." : `Pedido ${statusLabels[nextStatus].toLowerCase()}.`);
    await loadAgenda(true);
    await loadRetentionBatch();
  } catch (error) {
    console.error("Falha ao atualizar pedido", error);
    setDashboardAlert(error.message || "Não foi possível atualizar o pedido. Atualize a agenda e tente novamente.");
  }
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
    ["Nome", "Telefone", "Serviço", "Duração (min)", "Valor registrado (R$)", "Data e hora", "Status", "Observações", "Solicitado em"],
    ...bookings.map((booking) => [
      booking.name, booking.phone, booking.serviceName, booking.durationMinutes,
      (booking.priceCents / 100).toFixed(2).replace(".", ","), formatDateTime(booking.slotAt, CONFIG.timezone),
      statusLabels[displayStatus(booking)], booking.notes || "", formatDateTime(booking.createdAt, CONFIG.timezone),
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

async function loadRetentionBatch() {
  if (!currentUser || !settings.retentionEnabled) {
    $("retention-batch").hidden = true;
    return;
  }
  try {
    const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
    const q = sdk.query(sdk.collection(db, "bookings"),
      sdk.where("status", "in", terminalStatuses), sdk.where("slotAt", "<", sdk.Timestamp.fromDate(cutoff)),
      sdk.orderBy("slotAt", "asc"), sdk.limit(100));
    const snapshot = await sdk.getDocs(q);
    retentionCandidates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((booking) => eligibleForRetention(booking, cutoff));
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
    await expirePendingBookings();
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
$("new-service").addEventListener("click", () => services.length ? openServiceDialog() : openServiceDialog());
$("service-dialog").querySelector(".dialog-close").addEventListener("click", () => $("service-dialog").close());
$("service-form").addEventListener("submit", (event) => {
  if ($("service-form").querySelector("button[value=cancel]") === document.activeElement) return;
  event.preventDefault();
  saveService(event).catch((error) => setStatus("service-status", error.message, true));
});
$("schedule-form").addEventListener("submit", saveSchedule);
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


