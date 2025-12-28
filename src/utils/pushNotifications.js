let actionHandler = null;
export const setActionListener = (handler) => {
    console.log("🔔 Push Action Listener Registered (STUB)");
    actionHandler = handler;
};
export const registerPushNotifications = async (connectionId) => {
    console.log("Push notifications disabled for debug build.");
    return;
};
const saveTokenToSupabase = async (token, connectionId) => {
    // Stub
};
