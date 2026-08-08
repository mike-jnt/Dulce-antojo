import { EXPECTED_FIREBASE_PROJECT, firebaseConfig } from "./config/app-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics, isSupported as analyticsIsSupported } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const firebaseApp = initializeApp(firebaseConfig);

if (firebaseApp.options?.projectId !== EXPECTED_FIREBASE_PROJECT) {
  throw new Error(`Proyecto Firebase no autorizado: ${firebaseApp.options?.projectId || "desconocido"}`);
}

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const appDataRef = doc(db, "dulce_antojo_app", "estado_general");

analyticsIsSupported()
  .then((supported) => {
    if (supported) getAnalytics(firebaseApp);
  })
  .catch(() => {});

enableIndexedDbPersistence(db).catch(() => {
  // Si hay varias pestañas abiertas, Firestore puede desactivar la persistencia.
  // La sincronización en tiempo real continúa funcionando.
});
