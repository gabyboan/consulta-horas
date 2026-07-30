const API_BASE = "https://consulta-horas.recursoshumanos-hesm.workers.dev";
const WHATSAPP_NUMBER = "5493435099425";
const TIMEOUT_MS = 12000;
const ACCESS_STORAGE_KEY = "consultaHorasAccessToken";

const frm = document.getElementById("frm");
const dniInput = document.getElementById("dni");
const btn = document.getElementById("btn");

const out = document.getElementById("out");
const nombre = document.getElementById("nombre");
const dniOut = document.getElementById("dniOut");
const particulares = document.getElementById("particulares");
const enfermedad = document.getElementById("enfermedad");
const particularesCard = document.getElementById("particularesCard");
const enfermedadCard = document.getElementById("enfermedadCard");
const francosCard = document.getElementById("francosCard");
const francos = document.getElementById("francos");
const imprevistosCard = document.getElementById("imprevistosCard");
const imprevistos = document.getElementById("imprevistos");
const statusEl = document.getElementById("status");

const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");

let lastController = null;

function getAccessToken(){
  try { return sessionStorage.getItem(ACCESS_STORAGE_KEY) || ""; }
  catch (_) { return ""; }
}

function clearAccessToken(){
  try { sessionStorage.removeItem(ACCESS_STORAGE_KEY); }
  catch (_) {}
}

function goToGate(){
  clearAccessToken();
  window.location.replace("./");
}

function setPill(state, text){
  dot.classList.remove("ok", "bad");
  if(state === "ok") dot.classList.add("ok");
  if(state === "bad") dot.classList.add("bad");
  pillText.textContent = text;
}

function onlyDigits(s){ return (s || "").replace(/[^\d]/g, ""); }

function saludoPorHora(date = new Date()){
  const h = date.getHours();
  if (h >= 20 || h < 7) return "Buenas noches";
  if (h < 12) return "Buen día";
  return "Buenas tardes";
}

function setWhatsAppLink(){
  const wa = document.getElementById("waLink");
  if(!wa) return;

  const texto = `${saludoPorHora()}. Necesito ayuda con los permisos de salida`;
  wa.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(texto)}`;
}

function parseHhmmToMinutes(s){
  if(s == null) return null;
  const str = String(s).trim();
  if(!str) return null;

  const neg = str.startsWith("-");
  const raw = neg ? str.slice(1) : str;
  const parts = raw.split(":");
  if(parts.length !== 2) return null;

  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if(!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  return neg ? -(hh * 60 + mm) : hh * 60 + mm;
}

function estadoParticular(hhmm){
  const mins = parseHhmmToMinutes(hhmm);
  if(mins == null) return { label: "—", badge: "" };
  if(mins < 0) return { label: hhmm, badge: "EXCEDIDO" };
  if(mins === 0) return { label: hhmm, badge: "UTILIZADAS" };
  return { label: hhmm, badge: "DISPONIBLE" };
}

function cantidadDisponible(value, singular, plural){
  if(!Number.isInteger(value) || value < 0) return "—";
  return `${value} ${value === 1 ? singular : plural}`;
}

function mostrarHorasRegulares(value){
  const mostrar = value !== false;
  particularesCard.hidden = !mostrar;
  enfermedadCard.hidden = !mostrar;
}
function mostrarImprevistos(value){
  const tieneBeneficio = Number.isInteger(value) && value >= 0;
  imprevistosCard.hidden = !tieneBeneficio;
  imprevistos.textContent = tieneBeneficio
    ? cantidadDisponible(value, "imprevisto", "imprevistos")
    : "";
}

function mostrarFrancos(value){
  const disponibles = typeof value === "string" && /^-?\d{1,4}:\d{2}$/.test(value);
  francosCard.hidden = !disponibles;
  francos.textContent = disponibles ? `${value} hs` : "";
}
async function consultar(dni){
  const accessToken = getAccessToken();
  if(!accessToken){
    goToGate();
    const error = new Error("Acceso no verificado");
    error.accessExpired = true;
    throw error;
  }

  if(lastController) lastController.abort();
  const controller = new AbortController();
  lastController = controller;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try{
    const r = await fetch(`${API_BASE}/consulta?dni=${encodeURIComponent(dni)}`, {
      method: "GET",
      signal: controller.signal,
      headers: { "X-Consulta-Access": accessToken }
    });

    const data = await r.json().catch(() => ({}));
    if(!r.ok){
      if (r.status === 403) {
        goToGate();
        const error = new Error(data?.error || "La verificación venció");
        error.accessExpired = true;
        throw error;
      }
      throw new Error(data?.error || "Error");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (!getAccessToken()) {
    goToGate();
    return;
  }
  setWhatsAppLink();
});

dniInput.addEventListener("input", () => {
  dniInput.value = onlyDigits(dniInput.value).slice(0, 10);
  setWhatsAppLink();
});

frm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const dni = onlyDigits(dniInput.value);
  dniInput.value = dni;
  setWhatsAppLink();

  if(!/^\d{6,10}$/.test(dni)){
    out.style.display = "none";
    setPill("bad", "DNI inválido");
    alert("DNI inválido");
    return;
  }

  btn.disabled = true;
  setPill(null, "Consultando...");
  out.style.display = "none";

  try{
    const data = await consultar(dni);

    if(!data.found){
      out.style.display = "none";
      setPill("bad", "No encontrado");
      alert("No encontrado");
      return;
    }

    nombre.textContent = `${data.apellido || ""} ${data.nombre || ""}`.trim() || "Consulta encontrada";
    dniOut.textContent = data.dni_masked ? `DNI: ${data.dni_masked}` : "";

    mostrarHorasRegulares(data.mostrar_horas_regulares);

    const p = estadoParticular(data.particular_restantes_hhmm);
    particulares.textContent = `${p.label}${p.badge ? " — " + p.badge : ""}`;

    enfermedad.textContent = data.enfermedad_usada ? "NO disponible (ya usada)" : "DISPONIBLE";
    mostrarFrancos(data.francos_disponibles_hhmm);
    mostrarImprevistos(data.imprevistos_disponibles);

    if (p.badge === "EXCEDIDO") {
      setPill("bad", "Con excedente");
      statusEl.textContent = "Estado: excedido";
    } else {
      setPill("ok", "Consulta OK");
      statusEl.textContent = "Estado: normal";
    }

    out.style.display = "block";
  } catch(err){
    if (err?.accessExpired) return;
    console.error(err);
    out.style.display = "none";
    setPill("bad", "Error");
    alert(err.message || "Error");
  } finally {
    btn.disabled = false;
  }
});