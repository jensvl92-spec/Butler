
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import admin from "npm:firebase-admin@^12.0.0"

let firebaseApp: admin.app.App | undefined;

export function getFirebase(): admin.app.App {
    if (firebaseApp) return firebaseApp;

    const serviceAccountStr = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
    if (!serviceAccountStr) {
        throw new Error("Missing FIREBASE_SERVICE_ACCOUNT secret.");
    }

    try {
        const serviceAccount = JSON.parse(serviceAccountStr);
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Admin Initialized");
    } catch (e) {
        console.error("Failed to init Firebase", e);
        throw e;
    }

    return firebaseApp!;
}

export async function sendFCM(token: string, title: string, body: string, category?: string, customData?: Record<string, string>) {
    const app = getFirebase();

    // Construct message payload for V1 API
    const message: admin.messaging.Message = {
        token: token,
        notification: {
            title: title,
            body: body
        },
        data: {
            title: title,
            body: body,
            actionId: category || "",
            ...customData
        },
        android: {
            priority: 'high',
            notification: {
                clickAction: category || "FCM_PLUGIN_ACTIVITY",
                channelId: "butler_channel"
            }
        },
        apns: {
            payload: {
                aps: {
                    category: category,
                    sound: "default"
                }
            }
        }
    };

    try {
        const response = await app.messaging().send(message);
        console.log("✅ FCM Sent:", response);
        return response;
    } catch (error) {
        console.error("❌ FCM Failed:", error);
    }
}
