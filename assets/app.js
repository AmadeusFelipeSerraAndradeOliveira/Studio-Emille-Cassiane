import { CONFIG, DEFAULT_SCHEDULE } from "./config.js";
import { centsToMoney, currentPrice, generateTimeOptions, localDateInputValue, normalizePhone, whatsappUrl } from "./domain.js";
import { db, firebaseReady, sdk } from "./firebase.js";

const byId = (id) => document.getElementById(id);
const form = byId("booking-form");
const bookingDate = byId("booking-date");
const serviceSelect = byId("booking-service");
const timeSelect = byId("booking-time");
const submitButton = byId("booking-submit");
const bookingStatus = byId("booking-status");
const demoMode = new URLSearchParams(location.search).get("demo") === "1";

let services = [];
let schedule = null;
let availableSlots = [];
let slotsLoading = false;

for (const node of document.querySelectorAll("[data-studio-name]")) node.textContent = CONFIG.studioName;
byId("year").textContent = new Date().getFullYear();

const menuToggle = byId("menu-toggle");
menuToggle?.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  byId("main-nav").classList.toggle("is-open", !isOpen);
});
document.querySelectorAll("#main-nav a").forEach((link) => link.addEventListener("click", () => {
  menuToggle?.setAttribute("aria-expanded", "false");
  byId("main-nav").classList.remove("is-open");
}));

function showFormMessage(text, isError = false, link = null) {
  bookingStatus.textContent = text;
  bookingStatus.classList.toggle("is-error", isError);
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = " Abrir WhatsApp";
    bookingStatus.append(anchor);
  }
}

function renderServiceCards() {
  const container = byId("service-list");
  container.replaceChildren();
  if (!services.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = demoMode
      ? "Nenhum serviço de demonstração está disponível."
      : "Os serviços serão exibidos aqui assim que o studio concluir a configuração.";
    container.append(empty);
    return;
  }
  services.forEach((service, index) => {
    const { cents, promo } = currentPrice(service);
    const card = document.createElement("article");
    card.className = "service-card";
    const number = document.createElement("span");
    number.className = "service-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("h3");
    title.textContent = service.name;
    const description = document.createElement("p");
    description.textContent = service.description;
    const meta = document.createElement("div");
    meta.className = "service-meta";
    const price = document.createElement("div");
    price.className = "service-price";
    const current = document.createElement("strong");
    current.textContent = centsToMoney(cents);
    if (promo) {
      const badge = document.createElement("span");
      badge.className = "offer-tag";
      badge.textContent = "Oferta";
      current.append(badge);
      const old = document.createElement("s");
      old.textContent = centsToMoney(service.basePriceCents);
      price.append(old);
    }
    price.append(current);
    const duration = document.createElement("span");
    duration.className = "service-duration";
    duration.textContent = `${service.durationMinutes} min`;
    meta.append(price, duration);
    card.append(number, title, description, meta);
    container.append(card);
  });
}

function fillServiceSelect() {
  serviceSelect.replaceChildren(new Option("Selecione um serviço", ""));
  services.forEach((service) => {
    const option = new Option(`${service.name} · ${centsToMoney(currentPrice(service).cents)}`, service.id);
    serviceSelect.add(option);
  });
}

function renderContact() {
  const phone = CONFIG.whatsappE164.replace(/\D/g, "");
  const contact = byId("contact-whatsapp");
  if (phone) {
    contact.textContent = `+${phone}`;
    contact.href = `https://wa.me/${phone}`;
    contact.target = "_blank";
    contact.rel = "noopener noreferrer";
  }
  if (CONFIG.address) byId("contact-address").textContent = CONFIG.address;
  if (schedule?.enabled) {
    const days = schedule.workingDays.map((day) => ["", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"][day]).join(", ");
    byId("contact-hours").textContent = `${days} · ${formatMinute(schedule.openMinute)} às ${formatMinute(schedule.closeMinute)} (horário local)`;
  }
  if (CONFIG.instagramUrl) {
    const link = document.createElement("a");
    link.href = CONFIG.instagramUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Instagram ↗";
    byId("contact-social").append(link);
  }
}

function formatMinute(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function loadPublicData() {
  if (demoMode) {
    services = [
      { id: "demo-manicure", name: "Manicure", description: "Cuidado delicado para mãos e unhas.", durationMinutes: 60, basePriceCents: 5500, active: true },
      { id: "demo-design", name: "Design de sobrancelhas", description: "Design personalizado para realçar seu olhar.", durationMinutes: 30, basePriceCents: 4000, promoPriceCents: 3200, promoStartsAt: new Date(Date.now() - 86_400_000), promoEndsAt: new Date(Date.now() + 7 * 86_400_000), active: true },
      { id: "demo-hair", name: "Escova", description: "Finalização com movimento e brilho.", durationMinutes: 60, basePriceCents: 8000, active: true },
    ];
    schedule = { ...DEFAULT_SCHEDULE, enabled: true, workingDays: [1, 2, 3, 4, 5, 6], minimumLeadMinutes: 0, daysAhead: 60 };
    byId("demo-banner").hidden = false;
    byId("services-message").textContent = "Valores e horários ilustrativos, somente para conhecer a interface.";
    return;
  }
  if (!firebaseReady) {
    byId("services-message").textContent = "A configuração Firebase ainda não foi preenchida. O site está aguardando a configuração do proprietário.";
    showFormMessage("O formulário será habilitado depois da configuração Firebase.", true);
    return;
  }
  try {
    const [serviceSnapshot, scheduleSnapshot] = await Promise.all([
      sdk.getDocs(sdk.query(sdk.collection(db, "services"), sdk.where("active", "==", true), sdk.limit(30))),
      sdk.getDoc(sdk.doc(db, "settings", "public")),
    ]);
    services = serviceSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    schedule = scheduleSnapshot.exists() ? scheduleSnapshot.data() : null;
    if (!schedule?.enabled) {
      byId("services-message").textContent = "O catálogo está carregado. O studio ainda precisa publicar o expediente no painel para receber pedidos.";
    }
  } catch (error) {
    console.error("Falha ao carregar informações públicas", error);
    byId("services-message").textContent = "Não foi possível carregar os serviços. Verifique a conexão e tente novamente.";
    showFormMessage("Não foi possível conectar ao Firebase. Tente novamente em instantes.", true);
  }
}

async function refreshAvailableTimes() {
  const date = bookingDate.value;
  const selectedService = services.find((item) => item.id === serviceSelect.value);
  timeSelect.replaceChildren(new Option("Buscando horários…", ""));
  timeSelect.disabled = true;
  if (!date || !selectedService || !schedule?.enabled) {
    timeSelect.replaceChildren(new Option("Selecione um serviço e uma data", ""));
    return;
  }
  const candidates = generateTimeOptions({ date, service: selectedService, schedule, timezone: CONFIG.timezone });
  if (!candidates.length) {
    timeSelect.replaceChildren(new Option("Sem horários para esta data", ""));
    return;
  }
  if (demoMode) {
    availableSlots = candidates;
  } else {
    if (!firebaseReady) return;
    slotsLoading = true;
    try {
      const lockIds = [...new Set(candidates.flatMap((slot) => slot.lockIds))];
      const snapshots = await Promise.all(lockIds.map((id) => sdk.getDoc(sdk.doc(db, "slotLocks", id))));
      const lockById = new Map(lockIds.map((id, index) => [id, snapshots[index]]));
      availableSlots = candidates.filter((slot) => slot.lockIds.every((id) => {
        const lock = lockById.get(id);
        if (!lock?.exists()) return true;
        const value = lock.data();
        return value.status === "pending" && value.expiresAt?.toDate?.() <= new Date();
      }));
    } catch (error) {
      console.error("Falha ao consultar disponibilidade", error);
      timeSelect.replaceChildren(new Option("Falha ao consultar horários", ""));
      showFormMessage("Não foi possível consultar os horários disponíveis. Tente novamente.", true);
      return;
    } finally {
      slotsLoading = false;
    }
  }
  timeSelect.replaceChildren(new Option(availableSlots.length ? "Selecione um horário" : "Nenhum horário disponível", ""));
  availableSlots.forEach((slot) => timeSelect.add(new Option(slot.time, slot.time)));
  timeSelect.disabled = availableSlots.length === 0;
}

function setDateBounds() {
  const today = localDateInputValue(CONFIG.timezone);
  bookingDate.min = today;
  bookingDate.max = schedule?.daysAhead ? new Date(Date.UTC(...today.split("-").map((part, index) => Number(part) - (index === 1 ? 1 : 0))) + schedule.daysAhead * 86_400_000).toISOString().slice(0, 10) : "";
}

async function reserveSlot(payload, selectedSlot, selectedService) {
  const bookingRef = sdk.doc(db, "bookings", payload.id);
  const lockRefs = selectedSlot.lockIds.map((id) => sdk.doc(db, "slotLocks", id));
  const expiry = sdk.Timestamp.fromDate(new Date(Date.now() + 30 * 60_000));
  await sdk.runTransaction(db, async (transaction) => {
    const locks = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
    const now = Date.now();
    if (locks.some((lock) => lock.exists() && !(lock.data().status === "pending" && lock.data().expiresAt?.toDate?.().getTime() <= now))) {
      throw new Error("Este horário acabou de ser ocupado. Escolha outro horário disponível.");
    }
    const price = currentPrice(selectedService).cents;
    transaction.set(bookingRef, {
      name: payload.name,
      phone: payload.phone,
      serviceId: selectedService.id,
      serviceName: selectedService.name,
      durationMinutes: selectedService.durationMinutes,
      priceCents: price,
      slotAt: sdk.Timestamp.fromDate(selectedSlot.slotAt),
      slotMinute: selectedSlot.minute,
      slotLockIds: selectedSlot.lockIds,
      notes: payload.notes,
      status: "pending",
      createdAt: sdk.serverTimestamp(),
      updatedAt: sdk.serverTimestamp(),
      expiresAt: expiry,
    });
    lockRefs.forEach((ref, index) => transaction.set(ref, {
      bookingId: payload.id,
      status: "pending",
      slotAt: sdk.Timestamp.fromMillis(Number(selectedSlot.lockIds[index])),
      expiresAt: expiry,
    }));
  });
  return currentPrice(selectedService).cents;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const service = services.find((item) => item.id === data.get("serviceId"));
  const selected = availableSlots.find((item) => item.time === data.get("time"));
  if (!service || !selected) {
    showFormMessage("Selecione um serviço e um horário disponível.", true);
    return;
  }
  if (!demoMode && (!firebaseReady || !schedule?.enabled)) {
    showFormMessage("O agendamento ainda não está habilitado pelo studio.", true);
    return;
  }
  let phone;
  try {
    phone = normalizePhone(data.get("phone"));
  } catch (error) {
    showFormMessage(error.message, true);
    return;
  }
  const name = String(data.get("name")).trim();
  if (name.length < 2) {
    showFormMessage("Informe seu nome para continuar.", true);
    return;
  }
  const notes = String(data.get("notes") || "").trim();
  if (notes.length > 500) {
    showFormMessage("A observação deve ter até 500 caracteres.", true);
    return;
  }

  let whatsappWindow = null;
  if (!demoMode && CONFIG.whatsappE164.replace(/\D/g, "")) {
    whatsappWindow = window.open("about:blank", "_blank");
    if (whatsappWindow) whatsappWindow.opener = null;
  }
  submitButton.disabled = true;
  showFormMessage(demoMode ? "Validando o pedido de demonstração…" : "Enviando seu pedido com segurança…");
  try {
    const reservationId = crypto.randomUUID();
    const price = demoMode
      ? currentPrice(service).cents
      : await reserveSlot({ id: reservationId, name, phone, notes }, selected, service);
    if (demoMode) {
      showFormMessage("Demonstração concluída. Nenhum agendamento foi gravado nem enviado.");
    } else {
      const dateLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: CONFIG.timezone, dateStyle: "short" }).format(selected.slotAt);
      const message = `Olá! Meu nome é ${name}. Solicitei um horário para ${service.name} em ${dateLabel}, às ${selected.time}. Valor informado: ${centsToMoney(price)}. Sei que o pedido está pendente até a aprovação do studio.`;
      const url = whatsappUrl(CONFIG.whatsappE164, message);
      if (whatsappWindow) whatsappWindow.location.href = url;
      else if (CONFIG.whatsappE164) showFormMessage("Pedido recebido e pendente de aprovação. Se o WhatsApp não abriu, use o link abaixo.", false, url);
      else showFormMessage("Pedido recebido e pendente de aprovação. O studio ainda precisa configurar o número do WhatsApp para abrir a conversa.", false);
      timeSelect.value = "";
      await refreshAvailableTimes();
    }
    form.reset();
    timeSelect.replaceChildren(new Option("Selecione a data primeiro", ""));
    timeSelect.disabled = true;
  } catch (error) {
    if (whatsappWindow) whatsappWindow.close();
    console.error("Falha ao enviar pedido", error);
    showFormMessage(error.message || "Não foi possível enviar o pedido. Verifique a conexão e tente novamente.", true);
    await refreshAvailableTimes();
  } finally {
    submitButton.disabled = false;
  }
});

serviceSelect.addEventListener("change", refreshAvailableTimes);
bookingDate.addEventListener("change", refreshAvailableTimes);

await loadPublicData();
renderServiceCards();
fillServiceSelect();
renderContact();
setDateBounds();
