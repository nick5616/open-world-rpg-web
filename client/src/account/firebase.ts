// Google sign-in through the Firebase JS SDK, loaded only when a Firebase
// config is supplied (VITE_FIREBASE_*). Without one, nothing Firebase-related
// is downloaded and the Google button stays hidden.
//
// The SDK is imported from Google's CDN by URL instead of npm so the account
// module adds no dependency to the client bundle (and no edit to WP02's
// package.json); players who never press "Sign in with Google" never fetch it.
// The version is pinned: bump deliberately.

const FIREBASE_SDK_VERSION = '10.14.1';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
}

/** Firebase config from Vite env, or null when not configured. */
export function firebaseConfigFromEnv(): FirebaseConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !authDomain || !projectId) return null;
  return { apiKey, authDomain, projectId, appId: env.VITE_FIREBASE_APP_ID };
}

// Minimal shapes of the SDK surface we use (the CDN modules are untyped here).
interface FirebaseAppModule {
  initializeApp(config: FirebaseConfig, name?: string): unknown;
  getApps(): { name: string }[];
  getApp(name?: string): unknown;
}
interface FirebaseAuthModule {
  getAuth(app: unknown): unknown;
  GoogleAuthProvider: new () => unknown;
  signInWithPopup(auth: unknown, provider: unknown): Promise<{ user: { getIdToken(forceRefresh?: boolean): Promise<string> } }>;
}

async function load(): Promise<[FirebaseAppModule, FirebaseAuthModule]> {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
  const app = (await import(/* @vite-ignore */ `${base}/firebase-app.js`)) as FirebaseAppModule;
  const auth = (await import(/* @vite-ignore */ `${base}/firebase-auth.js`)) as FirebaseAuthModule;
  return [app, auth];
}

/**
 * Opens the Google sign-in popup and returns a Firebase ID token, which the
 * account service verifies (RS256 against Google's keys) and exchanges for a
 * Lodestone session.
 */
export async function signInWithGoogle(config: FirebaseConfig): Promise<string> {
  const [appMod, authMod] = await load();
  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  const cred = await authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider());
  return cred.user.getIdToken();
}
