import { LOCAL_STATE_KEY } from "./config/app-config.js";
import { auth, db } from "./firebase-client.js";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { clearIndexedDbPersistence, terminate } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let resolvedUser = null;
let authReadyPromise = null;

function el(id) {
  return document.getElementById(id);
}

function setAuthMessage(message = "", type = "info") {
  const box = el("authMessage");
  if (!box) return;
  box.textContent = message;
  box.className = `auth-message ${message ? "show" : ""} ${type}`.trim();
}

function setLoginBusy(busy) {
  const button = el("loginSubmit");
  const email = el("loginEmail");
  const password = el("loginPassword");
  if (button) {
    button.disabled = busy;
    button.innerHTML = busy
      ? '<span class="auth-spinner" aria-hidden="true"></span><span>Verificando…</span>'
      : '<span>Ingresar al sistema</span><span aria-hidden="true">→</span>';
  }
  if (email) email.disabled = busy;
  if (password) password.disabled = busy;
}

function mapAuthError(error) {
  const code = error?.code || "";
  if (["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password", "auth/invalid-email"].includes(code)) {
    return "Correo o contraseña incorrectos.";
  }
  if (code === "auth/too-many-requests") return "Demasiados intentos. Intenta nuevamente más tarde.";
  if (code === "auth/network-request-failed") return "No fue posible conectar. Revisa tu internet.";
  if (code === "auth/user-disabled") return "Esta cuenta está deshabilitada.";
  return "No fue posible iniciar sesión. Revisa tus datos e intenta nuevamente.";
}

function showAuthorizedApp(user) {
  resolvedUser = user;
  document.body.classList.remove("auth-locked");
  document.body.classList.add("auth-ready");
  const gate = el("authGate");
  const shell = el("appShell");
  if (gate) {
    gate.classList.add("is-hidden");
    gate.setAttribute("aria-hidden", "true");
  }
  if (shell) shell.removeAttribute("aria-hidden");
  const userEmail = el("authUserEmail");
  if (userEmail) userEmail.textContent = user.email || "Usuario autorizado";
  const userAvatar = el("authUserAvatar");
  if (userAvatar) userAvatar.textContent = (user.email || "U").trim().charAt(0).toUpperCase();
}

function showLoginGate() {
  resolvedUser = null;
  document.body.classList.add("auth-locked");
  document.body.classList.remove("auth-ready");
  const gate = el("authGate");
  const shell = el("appShell");
  if (gate) {
    gate.classList.remove("is-hidden");
    gate.setAttribute("aria-hidden", "false");
  }
  if (shell) shell.setAttribute("aria-hidden", "true");
}

async function handleLogin(event) {
  event.preventDefault();
  const email = (el("loginEmail")?.value || "").trim().toLowerCase();
  const password = el("loginPassword")?.value || "";
  const remember = Boolean(el("rememberSession")?.checked);

  setAuthMessage("");
  if (!email || !password) {
    setAuthMessage("Escribe tu correo y contraseña.", "error");
    return;
  }

  setLoginBusy(true);
  try {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const credential = await signInWithEmailAndPassword(auth, email, password);
    if (!credential.user?.email) {
      await signOut(auth);
      throw new Error("AUTH_EMAIL_REQUIRED");
    }
    setAuthMessage("Acceso autorizado. Cargando tu sistema…", "success");
  } catch (error) {
    setAuthMessage(mapAuthError(error), "error");
  } finally {
    setLoginBusy(false);
  }
}

async function handlePasswordReset(event) {
  event.preventDefault();
  const email = (el("loginEmail")?.value || "").trim().toLowerCase();
  if (!email) {
    setAuthMessage("Escribe primero el correo de la cuenta.", "error");
    el("loginEmail")?.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    // Mensaje deliberadamente neutro para no revelar si la cuenta existe.
    setAuthMessage("Si el correo corresponde a una cuenta habilitada, recibirás las instrucciones de recuperación.", "success");
  } catch (error) {
    if (error?.code === "auth/network-request-failed") {
      setAuthMessage("No fue posible conectar. Revisa tu internet.", "error");
    } else {
      setAuthMessage("No fue posible procesar la recuperación en este momento.", "error");
    }
  }
}

function setupAuthUi() {
  el("loginForm")?.addEventListener("submit", handleLogin);
  el("forgotPassword")?.addEventListener("click", handlePasswordReset);
  el("togglePassword")?.addEventListener("click", () => {
    const input = el("loginPassword");
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    const btn = el("togglePassword");
    if (btn) {
      btn.textContent = reveal ? "Ocultar" : "Ver";
      btn.setAttribute("aria-pressed", String(reveal));
    }
  });
  el("logoutButton")?.addEventListener("click", secureSignOut);
}

export function waitForAuthenticatedUser() {
  if (authReadyPromise) return authReadyPromise;
  setupAuthUi();
  showLoginGate();
  authReadyPromise = new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (user?.email) {
        showAuthorizedApp(user);
        if (!resolvedUser || resolvedUser.uid !== user.uid) resolvedUser = user;
        resolve(user);
      } else {
        showLoginGate();
      }
    });
  });
  return authReadyPromise;
}

export function currentAuthenticatedUser() {
  return auth.currentUser || resolvedUser;
}

export async function secureSignOut() {
  const button = el("logoutButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Cerrando…";
  }
  try {
    await signOut(auth);
  } finally {
    // Evita que la copia funcional de la aplicación quede expuesta en un equipo compartido.
    localStorage.removeItem(LOCAL_STATE_KEY);
    sessionStorage.clear();
    try {
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch (error) {
    }
    window.location.replace(window.location.href.split("#")[0]);
  }
}
