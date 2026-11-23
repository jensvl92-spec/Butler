package com.aiha.app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "DeviceControlPlugin")
class DeviceControlPlugin : Plugin() {

    companion object {
        private var torchEnabled: Boolean = false
    }

    private fun findFlashCameraId(cameraManager: CameraManager): String? {
        return try {
            for (id in cameraManager.cameraIdList) {
                val chars = cameraManager.getCameraCharacteristics(id)
                val hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                if (hasFlash && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    return id
                }
            }
            // Fallback: any camera with flash
            for (id in cameraManager.cameraIdList) {
                val chars = cameraManager.getCameraCharacteristics(id)
                if (chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true) {
                    return id
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    @PluginMethod
    fun setFlashlight(call: PluginCall) {
        val mode = (call.getString("mode") ?: "toggle").lowercase()
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
        if (cameraManager == null) {
            call.reject("CameraManager is niet beschikbaar op dit toestel.")
            return
        }

        val cameraId = findFlashCameraId(cameraManager)
        if (cameraId == null) {
            call.reject("Geen zaklamp/flitser gevonden op dit toestel.")
            return
        }

        val targetState = when (mode) {
            "on", "true", "aan" -> true
            "off", "false", "uit" -> false
            else -> !torchEnabled
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                cameraManager.setTorchMode(cameraId, targetState)
                torchEnabled = targetState
                val res = JSObject()
                res.put("enabled", torchEnabled)
                res.put("message", if (torchEnabled) "Zaklamp staat aan." else "Zaklamp staat uit.")
                call.resolve(res)
            } else {
                call.reject("Android 6.0 of hoger is vereist voor zaklampbediening.")
            }
        } catch (e: Exception) {
            call.reject("Kon zaklamp niet schakelen: ${e.message}")
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val streamName = (call.getString("stream") ?: "media").lowercase()
        val percent = call.getInt("percent")
        val direction = (call.getString("direction") ?: "").lowercase()
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager == null) {
            call.reject("AudioManager niet beschikbaar.")
            return
        }

        val streamType = when (streamName) {
            "ring", "beltoon", "ringer" -> AudioManager.STREAM_RING
            "alarm", "wekker" -> AudioManager.STREAM_ALARM
            "notification", "melding" -> AudioManager.STREAM_NOTIFICATION
            else -> AudioManager.STREAM_MUSIC
        }

        try {
            val maxVol = audioManager.getStreamMaxVolume(streamType)
            val currentVol = audioManager.getStreamVolume(streamType)
            val targetVol = when {
                percent != null -> {
                    val clamped = percent.coerceIn(0, 100)
                    Math.round((clamped / 100.0) * maxVol).toInt().coerceIn(0, maxVol)
                }
                direction == "up" || direction == "hoger" -> (currentVol + Math.max(1, maxVol / 5)).coerceAtMost(maxVol)
                direction == "down" || direction == "lager" -> (currentVol - Math.max(1, maxVol / 5)).coerceAtLeast(0)
                direction == "mute" || direction == "stil" -> 0
                else -> currentVol
            }

            audioManager.setStreamVolume(streamType, targetVol, AudioManager.FLAG_SHOW_UI)
            val newPct = if (maxVol > 0) Math.round((targetVol.toDouble() / maxVol) * 100).toInt() else 0
            val res = JSObject()
            res.put("stream", streamName)
            res.put("percent", newPct)
            res.put("volume", targetVol)
            res.put("maxVolume", maxVol)
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("Kon volume niet aanpassen: ${e.message}")
        }
    }

    @PluginMethod
    fun setRingerMode(call: PluginCall) {
        val mode = (call.getString("mode") ?: "normal").lowercase()
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager == null) {
            call.reject("AudioManager niet beschikbaar.")
            return
        }

        try {
            val targetMode = when (mode) {
                "vibrate", "trillen" -> AudioManager.RINGER_MODE_VIBRATE
                "silent", "stil", "mute" -> AudioManager.RINGER_MODE_SILENT
                else -> AudioManager.RINGER_MODE_NORMAL
            }
            audioManager.ringerMode = targetMode
            val res = JSObject()
            res.put("mode", mode)
            call.resolve(res)
        } catch (se: SecurityException) {
            // Android requires Notification Policy Access for silent/DND mode
            try {
                audioManager.ringerMode = AudioManager.RINGER_MODE_VIBRATE
                val res = JSObject()
                res.put("mode", "vibrate")
                res.put("note", "Toestel op trillen gezet (Niet Storen-machtiging vereist voor volledig stil).")
                call.resolve(res)
            } catch (e2: Exception) {
                call.reject("Geen machtiging voor Niet Storen / stil-modus: ${se.message}")
            }
        } catch (e: Exception) {
            call.reject("Kon geluidsmodus niet wijzigen: ${e.message}")
        }
    }

    @PluginMethod
    fun dialNumber(call: PluginCall) {
        val phone = (call.getString("phone") ?: "").trim()
        if (phone.isEmpty()) {
            call.reject("Geen telefoonnummer opgegeven.")
            return
        }
        try {
            val intent = Intent(Intent.ACTION_DIAL).apply {
                data = Uri.parse("tel:${Uri.encode(phone)}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            activity.startActivity(intent)
            val res = JSObject()
            res.put("opened", true)
            res.put("phone", phone)
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("Kon telefoon-app niet openen: ${e.message}")
        }
    }

    @PluginMethod
    fun openApp(call: PluginCall) {
        val appName = (call.getString("app") ?: "").lowercase().trim()
        val query = (call.getString("query") ?: "").trim()
        val pm = context.packageManager

        val packageMap = mapOf(
            "spotify" to "com.spotify.music",
            "youtube" to "com.google.android.youtube",
            "maps" to "com.google.android.apps.maps",
            "google maps" to "com.google.android.apps.maps",
            "whatsapp" to "com.whatsapp",
            "gmail" to "com.google.android.gm",
            "calendar" to "com.google.android.calendar",
            "agenda" to "com.google.android.calendar",
            "docs" to "com.google.android.apps.docs.editors.docs",
            "google docs" to "com.google.android.apps.docs.editors.docs",
            "sheets" to "com.google.android.apps.docs.editors.sheets",
            "google sheets" to "com.google.android.apps.docs.editors.sheets",
            "drive" to "com.google.android.apps.docs",
            "clock" to "com.google.android.deskclock",
            "klok" to "com.google.android.deskclock",
            "camera" to "com.android.camera",
            "waze" to "com.waze"
        )

        try {
            if (appName == "settings" || appName == "instellingen") {
                val intent = Intent(Settings.ACTION_SETTINGS).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                activity.startActivity(intent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", "settings")
                call.resolve(res)
                return
            }

            if (appName == "wifi" || appName == "wi-fi") {
                val intent = Intent(Settings.ACTION_WIFI_SETTINGS).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                activity.startActivity(intent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", "wifi")
                call.resolve(res)
                return
            }

            if (appName == "bluetooth") {
                val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                activity.startActivity(intent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", "bluetooth")
                call.resolve(res)
                return
            }

            if (appName == "spotify" && query.isNotEmpty()) {
                val uri = Uri.parse("spotify:search:${Uri.encode(query)}")
                val intent = Intent(Intent.ACTION_VIEW, uri).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                activity.startActivity(intent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", "spotify")
                call.resolve(res)
                return
            }

            if (appName == "youtube" && query.isNotEmpty()) {
                val uri = Uri.parse("https://www.youtube.com/results?search_query=${Uri.encode(query)}")
                val intent = Intent(Intent.ACTION_VIEW, uri).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
                activity.startActivity(intent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", "youtube")
                call.resolve(res)
                return
            }

            val pkg = packageMap[appName] ?: appName
            val launchIntent = pm.getLaunchIntentForPackage(pkg)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(launchIntent)
                val res = JSObject()
                res.put("opened", true)
                res.put("app", appName)
                call.resolve(res)
            } else {
                call.reject("App '$appName' is niet geïnstalleerd op dit toestel.")
            }
        } catch (e: Exception) {
            call.reject("Kon app '$appName' niet openen: ${e.message}")
        }
    }

    @PluginMethod
    fun getBatteryStatus(call: PluginCall) {
        try {
            val ifilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            val batteryStatus = context.registerReceiver(null, ifilter)
            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) Math.round((level * 100.0) / scale).toInt() else -1
            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL

            val res = JSObject()
            res.put("percent", pct)
            res.put("isCharging", isCharging)
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("Kon batterijstatus niet uitlezen: ${e.message}")
        }
    }

    @PluginMethod
    fun setKeepScreenOn(call: PluginCall) {
        val enabled = call.getBoolean("enabled", false) ?: false
        activity.runOnUiThread {
            try {
                if (enabled) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                val res = JSObject()
                res.put("enabled", enabled)
                call.resolve(res)
            } catch (e: Exception) {
                call.reject("Kon schermstand niet aanpassen: ${e.message}")
            }
        }
    }
}
