// Snap Diary settings you edit once after creating your Google Cloud OAuth
// client (see README.md). Nothing here is secret: an OAuth *client ID* for a
// browser app is public by design. Never put a client *secret* in this file.
export const SITE_CONFIG = {
  // "123456789-abc.apps.googleusercontent.com". Can also be pasted in the
  // app's 설정 screen, which overrides this value on that device only.
  googleClientId: "",

  // Optional extra lock: only these Google accounts may connect. Leave empty to
  // rely on the OAuth consent screen's test-user list (recommended).
  allowedEmails: [],

  // Top-level folder created in your Google Drive.
  driveFolderName: "Snap Diary"
};
