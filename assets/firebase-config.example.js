export const firebaseConfig = {
  apiKey: "",
  authDomain: "m",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.trim() !== "" && !value.startsWith("PASTE_"),
);
