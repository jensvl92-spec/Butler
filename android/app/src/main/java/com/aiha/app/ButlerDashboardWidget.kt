package com.aiha.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Butler Dashboard Widget
 * Shows temperature, energy usage, and presence status with direct HA API fetching.
 * 
 * Features:
 * - 15-minute auto-refresh via system
 * - Manual refresh button
 * - Voice input button
 * - Direct Home Assistant API calls
 */
class ButlerDashboardWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        val pendingResult = goAsync()
        thread {
            try {
                for (appWidgetId in appWidgetIds) {
                    updateAppWidgetSync(context, appWidgetManager, appWidgetId)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_REFRESH) {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS)
            if (appWidgetIds != null && appWidgetIds.isNotEmpty()) {
                val pendingResult = goAsync()
                thread {
                    try {
                        appWidgetIds.forEach { id ->
                            updateAppWidgetSync(context, appWidgetManager, id)
                        }
                    } finally {
                        pendingResult.finish()
                    }
                }
            }
            return
        }
        super.onReceive(context, intent)
    }

    companion object {
        const val ACTION_REFRESH = "com.aiha.app.WIDGET_REFRESH"

        private const val CAPACITOR_PREFS = "CapacitorStorage"
        private const val WIDGET_PREFS = "ButlerWidget"

        private const val KEY_HA_URL = "ButlerWidget.ha_url"
        private const val KEY_HA_TOKEN = "ButlerWidget.ha_token"

        private const val KEY_TEMP_ENTITY = "temp_entity"
        private const val KEY_ENERGY_ENTITY = "energy_entity"
        private const val KEY_CACHE_TEMP = "cache_temp"
        private const val KEY_CACHE_ENERGY = "cache_energy"
        private const val KEY_CACHE_PRESENCE = "cache_presence"

        fun saveHACredentials(context: Context, url: String, token: String) {
            val prefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(KEY_HA_URL, url)
                .putString(KEY_HA_TOKEN, token)
                .apply()
        }

        fun setEntities(context: Context, tempEntity: String?, energyEntity: String?) {
            val prefs = context.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(KEY_TEMP_ENTITY, tempEntity ?: "sensor.temperature")
                .putString(KEY_ENERGY_ENTITY, energyEntity ?: "sensor.daily_energy")
                .apply()
        }

        internal fun updateAppWidgetSync(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            try {
                val capacitorPrefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                val widgetPrefs = context.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)

                val views = RemoteViews(context.packageName, R.layout.widget_dashboard)

                val voiceIntent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("butler://voice")).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val voicePendingIntent = PendingIntent.getActivity(
                    context, appWidgetId, voiceIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.voice_button, voicePendingIntent)

                val refreshIntent = Intent(context, ButlerDashboardWidget::class.java).apply {
                    action = ACTION_REFRESH
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(appWidgetId))
                }
                val refreshPendingIntent = PendingIntent.getBroadcast(
                    context, appWidgetId + 1000, refreshIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.refresh_button, refreshPendingIntent)

                views.setTextViewText(R.id.temp_value, widgetPrefs.getString(KEY_CACHE_TEMP, "--°C"))
                views.setTextViewText(R.id.energy_value, widgetPrefs.getString(KEY_CACHE_ENERGY, "-- kWh"))
                views.setTextViewText(R.id.presence_text, widgetPrefs.getString(KEY_CACHE_PRESENCE, "👤 Tap to refresh"))
                Handler(Looper.getMainLooper()).post {
                    appWidgetManager.updateAppWidget(appWidgetId, views)
                }

                val haUrl = capacitorPrefs.getString(KEY_HA_URL, null)
                val haToken = capacitorPrefs.getString(KEY_HA_TOKEN, null)

                if (haUrl != null && haToken != null) {
                    val states = fetchHAStates(haUrl, haToken)

                    val tempEntity = widgetPrefs.getString(KEY_TEMP_ENTITY, "sensor.temperature") ?: ""
                    val energyEntity = widgetPrefs.getString(KEY_ENERGY_ENTITY, "sensor.daily_energy") ?: ""

                    var tempValue = "--°C"
                    var energyValue = "-- kWh"
                    val presencePeople = mutableListOf<String>()
                    val tempCandidates = mutableListOf<Triple<String, Double, Int>>()

                    for (i in 0 until states.length()) {
                        val entity = states.getJSONObject(i)
                        val entityId = entity.getString("entity_id")
                        val state = entity.getString("state")
                        val attrs = entity.optJSONObject("attributes")
                        val friendlyName = attrs?.optString("friendly_name", "")?.lowercase() ?: ""
                        val entityIdLower = entityId.lowercase()
                        val deviceClass = attrs?.optString("device_class", "") ?: ""

                        val isTemperatureSensor = (deviceClass == "temperature") ||
                            (entityIdLower.startsWith("sensor.") && entityIdLower.contains("temperature")) ||
                            (entityIdLower.startsWith("climate."))

                        val isConfiguredEntity = entityId == tempEntity && tempEntity.isNotEmpty()

                        if (isTemperatureSensor || isConfiguredEntity) {
                            if (state == "unavailable" || state == "unknown" || state.isEmpty()) continue
                            try {
                                val temp = if (entityIdLower.startsWith("climate.")) {
                                    attrs?.optDouble("current_temperature", Double.NaN) ?: Double.NaN
                                } else {
                                    state.toDouble()
                                }
                                if (temp.isNaN() || temp < -40 || temp > 60) continue

                                val isSystemSensor = listOf(
                                    "cpu", "processor", "raspberry", "soc", "core", "thermal",
                                    "hardware", "system", "disk", "memory", "gpu", "chipset",
                                    "motherboard", "nvme", "ssd", "hdd", "acpi", "pch",
                                    "vrm", "power_supply", "ups", "nas", "server", "pi_hole"
                                ).any { pattern -> entityIdLower.contains(pattern) || friendlyName.contains(pattern) }

                                val isOutdoor = listOf(
                                    "outdoor", "buiten", "external", "outside", "weer", "weather",
                                    "forecast", "openweathermap", "ecowitt", "netatmo_outdoor", "tuin", "garden"
                                ).any { pattern -> entityIdLower.contains(pattern) || friendlyName.contains(pattern) }

                                val isLivingRoom = listOf(
                                    "woonkamer", "living", "huiskamer", "lounge", "salon"
                                ).any { pattern -> entityIdLower.contains(pattern) || friendlyName.contains(pattern) }

                                val isOtherRoom = listOf(
                                    "slaapkamer", "bedroom", "keuken", "kitchen", "badkamer",
                                    "bathroom", "kantoor", "office", "gang", "hallway", "zolder",
                                    "attic", "kelder", "basement", "garage"
                                ).any { pattern -> entityIdLower.contains(pattern) || friendlyName.contains(pattern) }

                                val priority = when {
                                    isConfiguredEntity -> 0
                                    isSystemSensor -> 100
                                    isOutdoor -> 99
                                    isLivingRoom -> 1
                                    isOtherRoom -> 2
                                    deviceClass == "temperature" -> 3
                                    entityIdLower.startsWith("climate.") -> 4
                                    else -> 10
                                }

                                tempCandidates.add(Triple(entityId, temp, priority))
                            } catch (_: Exception) {}
                        }

                        if ((entityIdLower.contains("daily") && entityIdLower.contains("energy")) || entityId == energyEntity) {
                            val unit = attrs?.optString("unit_of_measurement", "kWh") ?: "kWh"
                            try {
                                val energy = state.toDouble()
                                energyValue = "${"%.1f".format(energy)} $unit"
                            } catch (_: Exception) {}
                        }

                        if (entityId.startsWith("person.") && state == "home") {
                            val name = attrs?.optString("friendly_name", entityId.replace("person.", ""))
                                ?: entityId.replace("person.", "")
                            presencePeople.add(name)
                        }
                    }

                    if (tempCandidates.isNotEmpty()) {
                        val roomCandidates = tempCandidates.filter { it.third < 50 }
                        val finalCandidates = if (roomCandidates.isNotEmpty()) roomCandidates else tempCandidates
                        val best = finalCandidates.minByOrNull { it.third }!!
                        tempValue = "${best.second.toInt()}°C"
                    }

                    val presenceText = when {
                        presencePeople.isEmpty() -> "👤 Nobody home"
                        presencePeople.size == 1 -> "👤 ${presencePeople[0]} home"
                        else -> "👤 ${presencePeople.size} people home"
                    }

                    Handler(Looper.getMainLooper()).post {
                        widgetPrefs.edit()
                            .putString(KEY_CACHE_TEMP, tempValue)
                            .putString(KEY_CACHE_ENERGY, energyValue)
                            .putString(KEY_CACHE_PRESENCE, presenceText)
                            .apply()

                        views.setTextViewText(R.id.temp_value, tempValue)
                        views.setTextViewText(R.id.energy_value, energyValue)
                        views.setTextViewText(R.id.presence_text, presenceText)
                        appWidgetManager.updateAppWidget(appWidgetId, views)
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("ButlerWidget", "Error updating widget", e)
            }
        }

        private fun fetchHAStates(url: String, token: String): JSONArray {
            val cleanBase = url.trim().trimEnd('/')
            val connection = URL("$cleanBase/api/states").openConnection() as HttpURLConnection
            return try {
                connection.requestMethod = "GET"
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.connectTimeout = 10000
                connection.readTimeout = 10000

                val status = connection.responseCode
                if (status !in 200..299) {
                    throw RuntimeException("HA returned HTTP $status")
                }
                val response = connection.inputStream.bufferedReader().use { it.readText() }
                JSONArray(response)
            } finally {
                connection.disconnect()
            }
        }
    }
}
