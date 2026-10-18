import { CONFIG } from "./config.js";

const placeholders = new Set(["", "PREENCHER_NO_FIREBASE_CONSOLE"]);
const emulatorMode = new URLSearchParams(location.search).get("emulator") === "1";
const configured = Object.values(CONFIG.firebase).every((value) => !placeholders.has(value));
const appConfig = emulatorMode && !configured
  ? { apiKey: "demo-api-key", authDomain: "localhost", projectId: "demo-studio-emille", appId: "1:1234567890:web:emulator" }
  : CONFIG.firebase;
export const firebaseReady = emulatorMode || configured;

export let app = null;
export let auth = null;
export let db = null;
export let sdk = null;

if (firebaseReady) {
  const version = "12.19.0";
  const [appApi, authApi, firestoreApi] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`),
  ]);
  app = appApi.initializeApp(appConfig);
  let appCheckApi = null;
  if (!emulatorMode && CONFIG.recaptchaV3SiteKey) {
    appCheckApi = await import(`https://www.gstatic.com/firebasejs/${version}/firebase-app-check.js`);
    appCheckApi.initializeAppCheck(app, {
      provider: new appCheckApi.ReCaptchaV3Provider(CONFIG.recaptchaV3SiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  auth = authApi.getAuth(app);
  db = firestoreApi.getFirestore(app);
  if (emulatorMode) {
    firestoreApi.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    authApi.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  sdk = Object.freeze({ ...appApi, ...authApi, ...firestoreApi, ...(appCheckApi || {}) });
}
