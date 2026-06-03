const API_BASE = "https://consulta-horas.recursoshumanos-hesm.workers.dev";
const WHATSAPP_NUMBER = "5493435099425";
const TIMEOUT_MS = 12000;

const frm = document.getElementById("frm");
const dniInput = document.getElementById("dni");
const btn = document.getElementById("btn");

const out = document.getElementById("out");
const nombre = document.getElementById("nombre");
const dniOut = document.getElementById("dniOut");
const particulares = document.getElementById("particulares");
const enfermedad = document.getElementById("enfermedad");
const msg = document.getElementById("msg");
const statusEl = document.getElementById("status");

const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");

let lastController = null;

let TURNSTILE_TOKEN = "";

window.onTurnstileOk = (token) => {
  TURNSTILE_TOKEN = token || "";
};

window.onTurnstileExpired = () => {
  TURNSTILE_TOKEN = "";
};

window.onTurnstileError = () => {
  TURNSTILE_TOKEN = "";
};

function getTurnstileToken(){
  return TURNSTILE_TOKEN;
}

function resetTurnstile(){
  TURNSTILE_TOKEN = "";
  try{
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      window.turnstile.reset();
    }
  } catch (_) {}
}

function setPill(state, text){
  dot.classList.remove("ok","bad");
  if(state === "ok") dot.classList.add("ok");
  if(state === "bad") dot.classList.add("bad");
  pillText.textContent = text;
}

function onlyDigits(s){ return (s || "").replace(/[^\d]/g, ""); }

function saludoPorHora(date = new Date()){
  const h = date.getHours();
  if (h >= 20 || h < 7) return "Buenas Noches";
  if (h < 12) return "Buen día";
  return "Buenas Tardes";
}

function setWhatsAppLink(){
  const wa = document.getElementById("waLink");
  if(!wa) return;

  const saludo = saludoPorHora();
  const texto = `${saludo}. Necesito ayuda con los permisos de salida`;
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

  const total = hh * 60 + mm;
  return neg ? -total : total;
}

function estadoParticular(hhmm){
  const mins = parseHhmmToMinutes(hhmm);
  if(mins == null) return { label: "—", badge: "" };

  if(mins < 0) return { label: hhmm, badge: "EXCEDIDO" };
  if(mins === 0) return { label: hhmm, badge: "UTILIZADAS" };
  return { label: hhmm, badge: "DISPONIBLE" };
}

async function consultar(dni){
  const token = getTurnstileToken();
  if(!token) throw new Error("Captcha no verificado");

  if(lastController) lastController.abort();
  const controller = new AbortController();
  lastController = controller;

  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try{
    const r = await fetch(`${API_BASE}/consulta?dni=${encodeURIComponent(dni)}`, {
      method: "GET",
      signal: controller.signal,
      headers: { "X-Turnstile-Token": token }
    });

    const data = await r.json().catch(() => ({}));

    if(!r.ok){
      if (r.status === 403) {
        throw new Error(data?.error || "Captcha inválido / requerido");
      }
      throw new Error(data?.error || "Error");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setWhatsAppLink();
});

dniInput.addEventListener("input", () => {
  dniInput.value = onlyDigits(dniInput.value).slice(0,10);
  setWhatsAppLink();
});

frm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const dni = onlyDigits(dniInput.value);
  dniInput.value = dni;
  setWhatsAppLink();

  if(!/^\d{6,10}$/.test(dni)){
    out.style.display = "none";
    setPill("bad","DNI inválido");
    alert("DNI inválido");
    return;
  }

  btn.disabled = true;
  setPill(null,"Consultando...");
  out.style.display = "none";

  try{
    const data = await consultar(dni);

    if(!data.found){
      out.style.display = "none";
      setPill("bad","No encontrado");
      alert("No encontrado");
      resetTurnstile();
      return;
    }

    nombre.textContent = `${data.apellido || ""} ${data.nombre || ""}`.trim() || "Consulta encontrada";
    dniOut.textContent = data.dni_masked ? `DNI: ${data.dni_masked}` : "";

    const p = estadoParticular(data.particular_restantes_hhmm);
    particulares.textContent = `${p.label}${p.badge ? " — " + p.badge : ""}`;

    const enfUsada = !!data.enfermedad_usada;
    enfermedad.textContent = enfUsada ? "NO disponible (ya usada)" : "DISPONIBLE";

    const mins = parseHhmmToMinutes(data.particular_restantes_hhmm);
    let m = "";

    m += enfUsada
      ? "Horas por enfermedad: ya usadas este mes.\n"
      : "Horas por enfermedad: disponibles (1 vez por mes).\n";

    if(mins != null && mins < 0){
      m += `Horas particulares: excedidas (${data.particular_restantes_hhmm}).`;
      msg.className = "msg bad";
      setPill("bad","Con excedente");
      statusEl.textContent = "Estado: excedido";
    } else if(mins === 0){
      m += `Horas particulares: utilizadas (${data.particular_restantes_hhmm || "0:00"}).`;
      msg.className = "msg ok";
      setPill("ok","Consulta OK");
      statusEl.textContent = "Estado: normal";
    } else {
      m += `Horas particulares disponibles: ${data.particular_restantes_hhmm || "—"}.`;
      msg.className = "msg ok";
      setPill("ok","Consulta OK");
      statusEl.textContent = "Estado: normal";
    }

    msg.textContent = m;
    out.style.display = "block";

    resetTurnstile();

  } catch(err){
    console.error(err);
    out.style.display = "none";
    setPill("bad","Captcha / Error");
    alert(err.message || "Error");
    resetTurnstile();
  } finally {
    btn.disabled = false;
  }
});
