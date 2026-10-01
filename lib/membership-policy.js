// Shared by the hosted account service and the desktop main process.
// Update this policy, deploy the backend AND rebuild the desktop application.
// Ordinary single-note downloads stay free. Original videos require membership
// on the website and an authorized bound device in the desktop client.
export const KNOWN_FEATURES = Object.freeze(['single-download', 'profile-download', 'watermark-free-video']);
export const PROTECTED_FEATURES = Object.freeze(['profile-download', 'watermark-free-video']);
