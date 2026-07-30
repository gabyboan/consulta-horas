const API_BASE = "https://consulta-horas.recursoshumanos-hesm.workers.dev";
const WHATSAPP_NUMBER = "5493435099425";
const ACCESS_STORAGE_KEY = "consultaHorasAccessToken";

const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");
const gateMessage = document.getElementById("gateMessage");
let verifying = false;

function setPill(state, text){
  dot.classList.remove("ok", "bad");
  if(state === "ok") dot.classList.add("ok");
  if(state === "bad") dot.classList.add("bad");
  pillText.textContent = text;
}

function resetTurnstile(){
  try {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      window.turnstile.reset();
    }
  } catch (_) {}
}

function clearAccessToken(){
  try { sessionStorage.removeItem(ACCESS_STORAGE_KEY); }
  catch (_) {}
}

function saveAccessToken(token){
  try {
    sessionStorage.setItem(ACCESS_STORAGE_KEY, token);
    return true;
  } catch (_) {
    return false;
  }
}

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

window.onTurnstileOk = async (turnstileToken) => {
  if (!turnstileToken || verifying) return;

  verifying = true;
  setPill(null, "Verificando...");
  gateMessage.textContent = "Validando el CAPTCHA...";

  try {
    const response = await fetch(`${API_BASE}/acceso`, {
      method: "POST",
      headers: { "X-Turnstile-Token": turnstileToken },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.access_token) {
      throw new Error(data?.error || "No se pudo validar el CAPTCHA");
    }
    if (!saveAccessToken(data.access_token)) {
      throw new Error("No se pudo preparar el acceso en este navegador");
    }

    setPill("ok", "Acceso habilitado");
    gateMessage.textContent = "Verificación correcta. Ingresando a la consulta...";
    window.setTimeout(() => window.location.replace("./consulta.html"), 350);
  } catch (error) {
    console.error(error);
    clearAccessToken();
    setPill("bad", "No verificado");
    gateMessage.textContent = error instanceof Error
      ? error.message
      : "No se pudo validar el CAPTCHA. Intentá nuevamente.";
    resetTurnstile();
    verifying = false;
  }
};

window.onTurnstileExpired = () => {
  if (verifying) return;
  clearAccessToken();
  setPill("bad", "Verificación vencida");
  gateMessage.textContent = "La verificación venció. Completala nuevamente para continuar.";
};

window.onTurnstileError = () => {
  if (verifying) return;
  clearAccessToken();
  setPill("bad", "Error de verificación");
  gateMessage.textContent = "No se pudo cargar la verificación. Recargá la página e intentá nuevamente.";
};

document.addEventListener("DOMContentLoaded", () => {
  clearAccessToken();
  setWhatsAppLink();
});
