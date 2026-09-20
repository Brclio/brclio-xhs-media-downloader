// Shared by the hosted account service and the desktop main process.
// Update this policy, deploy the backend AND rebuild the desktop application.
// Existing single-note downloads stay free; profile batches require membership
// and an authorized bound device.
export const KNOWN_FEATURES = Object.freeze(['single-download', 'profile-download']);
export const PROTECTED_FEATURES = Object.freeze(['profile-download']);
