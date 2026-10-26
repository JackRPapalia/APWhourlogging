// Site settings. None of these are secrets: Firebase web config is meant to be public,
// and the Apps Script checks every request's Firebase login before touching the sheet.

// Firebase console → Project settings → General → Your apps → SDK setup and configuration → Config
export const firebaseConfig = {
  apiKey: "AIzaSyBb8wcNriO5UCBHXG710Qz7Jo_Gba90Vq0",
  authDomain: "apwhourlogging.firebaseapp.com",
  projectId: "apwhourlogging",
  appId: "1:383552940572:web:433e50726d78873fe9cdd9",
};

// Apps Script → Deploy → Manage deployments → Web app URL (ends in /exec)
export const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxgqUVNOesFyhovkevEJJZo3YJRAFLNcNgGL-aM6-I5cpleA3WE8Z3XWLdo_kXax1MxAg/exec";
