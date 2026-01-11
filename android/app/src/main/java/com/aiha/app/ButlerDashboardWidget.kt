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
        for (appWidgetId in appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        
        // Handle manual refresh
        if (intent.action == ACTION_REFRESH) {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS)
            appWidgetIds?.forEach { id ->
                updateAppWidget(context, appWidgetManager, id)
            }
        }
    }

    companion object {
        const val ACTION_REFRESH = "com.aiha.app.WIDGET_REFRESH"
        
        // Capacitor Preferences uses this specific SharedPreferences name
        private const val CAPACITOR_PREFS = "CapacitorStorage"
        private const val WIDGET_PREFS = "ButlerWidget"
        
        // Keys as stored by Capacitor (prefixed)
        private const val KEY_HA_URL = "ButlerWidget.ha_url"
        private const val KEY_HA_TOKEN = "ButlerWidget.ha_token"
        
        // Widget-specific keys (not from Capacitor)
        private const val KEY_TEMP_ENTITY = "temp_entity"
        private const val KEY_ENERGY_ENTITY = "energy_entity"
        private const val KEY_CACHE_TEMP = "cache_temp"
        private const val KEY_CACHE_ENERGY = "cache_energy"
        private const val KEY_CACHE_PRESENCE = "cache_presence"

        /**
         * Save HA credentials for widget use (called from app)
         * Note: Credentials are now synced via Capacitor Preferences, so this is a backup option
         */
        fun saveHACredentials(context: Context, url: String, token: String) {
            val prefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(KEY_HA_URL, url)
                .putString(KEY_HA_TOKEN, token)
                .apply()
        }

        /**
         * Configure which entities to display
         */
        fun setEntities(context: Context, tempEntity: String?, energyEntity: String?) {
            val prefs = context.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(KEY_TEMP_ENTITY, tempEntity ?: "sensor.temperature")
                .putString(KEY_ENERGY_ENTITY, energyEntity ?: "sensor.daily_energy")
                .apply()
        }

        internal fun updateAppWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            try {
                // Capacitor stores HA credentials here
                val capacitorPrefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                // Widget cache stored separately
                val widgetPrefs = context.getSharedPreferences(WIDGET_PREFS, Context.MODE_PRIVATE)
                
                val views = RemoteViews(context.packageName, R.layout.widget_dashboard)

                // Set up voice button (Deep Link)
                val voiceIntent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("butler://voice")).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val voicePendingIntent = PendingIntent.getActivity(
                    context, appWidgetId, voiceIntent, // Use ID for unique code
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.voice_button, voicePendingIntent)

                // Set up refresh button
                val refreshIntent = Intent(context, ButlerDashboardWidget::class.java).apply {
                    action = ACTION_REFRESH
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(appWidgetId))
                }
                val refreshPendingIntent = PendingIntent.getBroadcast(
                    context, appWidgetId + 1000, refreshIntent, // Offset ID for unique code
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.refresh_button, refreshPendingIntent)

                // Show cached values first
                views.setTextViewText(R.id.temp_value, widgetPrefs.getString(KEY_CACHE_TEMP, "--°C"))
                views.setTextViewText(R.id.energy_value, widgetPrefs.getString(KEY_CACHE_ENERGY, "-- kWh"))
                views.setTextViewText(R.id.presence_text, widgetPrefs.getString(KEY_CACHE_PRESENCE, "👤 Tap to refresh"))
                appWidgetManager.updateAppWidget(appWidgetId, views)

                // Get HA credentials from Capacitor storage
                val haUrl = capacitorPrefs.getString(KEY_HA_URL, null)
                val haToken = capacitorPrefs.getString(KEY_HA_TOKEN, null)

                if (haUrl != null && haToken != null) {
                    thread {
                        try {
                            val states = fetchHAStates(haUrl, haToken)
                            
                            val tempEntity = widgetPrefs.getString(KEY_TEMP_ENTITY, "sensor.temperature") ?: ""
                            val energyEntity = widgetPrefs.getString(KEY_ENERGY_ENTITY, "sensor.daily_energy") ?: ""
                            
                            // Find values - collect all temperature candidates
                            var tempValue = "--°C"
                            var energyValue = "-- kWh"
                            val presencePeople = mutableListOf<String>()
                            
                            // Temperature candidates: entity_id -> (value, priority)
                            // Priority: 1=living room, 2=indoor/room, 3=any temp sensor
                            val tempCandidates = mutableListOf<Triple<String, Double, Int>>()
                            
                            for (i in 0 until states.length()) {
                                val entity = states.getJSONObject(i)
                                val entityId = entity.getString("entity_id")
                                val state = entity.getString("state")
                                val attrs = entity.optJSONObject("attributes")
                                val friendlyName = attrs?.optString("friendly_name", "")?.lowercase() ?: ""
                                val entityIdLower = entityId.lowercase()
                                val deviceClass = attrs?.optString("device_class", "") ?: ""
                                
                                // Temperature detection - check device_class first, then entity patterns
                                val isTemperatureSensor = (deviceClass == "temperature") ||
                                    (entityIdLower.startsWith("sensor.") && entityIdLower.contains("temperature")) ||
                                    (entityIdLower.startsWith("climate."))
                                    
                                val isConfiguredEntity = entityId == tempEntity && tempEntity.isNotEmpty()
                                
                                if (isTemperatureSensor || isConfiguredEntity) {
                                    // Skip unavailable/unknown states
                                    if (state == "unavailable" || state == "unknown" || state.isEmpty()) {
                                        continue
                                    }
                                    
                                    try {
                                        // For climate entities, get current_temperature from attributes
                                        val temp = if (entityIdLower.startsWith("climate.")) {
                                            attrs?.optDouble("current_temperature", Double.NaN) ?: Double.NaN
                                        } else {
                                            state.toDouble()
                                        }
                                        
                                        if (temp.isNaN()) continue
                                        
                                        // Skip unreasonable temperatures (probably device sensors or Fahrenheit)
                                        if (temp < -40 || temp > 60) continue
                                        
                                        // Check for system/hardware sensor patterns to EXCLUDE
                                        val isSystemSensor = listOf(
                                            "cpu", "processor", "raspberry", "soc", "core", "thermal",
                                            "hardware", "system", "disk", "memory", "gpu", "chipset",
                                            "motherboard", "nvme", "ssd", "hdd", "acpi", "pch",
                                            "vrm", "power_supply", "ups", "nas", "server", "pi_hole"
                                        ).any { pattern ->
                                            entityIdLower.contains(pattern) || friendlyName.contains(pattern)
                                        }
                                        
                                        // Check for outdoor patterns
                                        val isOutdoor = listOf(
                                            "outdoor", "buiten", "external", "outside", "weer", "weather",
                                            "forecast", "openweathermap", "ecowitt", "netatmo_outdoor", "tuin", "garden"
                                        ).any { pattern ->
                                            entityIdLower.contains(pattern) || friendlyName.contains(pattern)
                                        }
                                        
                                        // Check for room patterns (preferred)
                                        val isLivingRoom = listOf(
                                            "woonkamer", "living", "huiskamer", "lounge", "salon"
                                        ).any { pattern ->
                                            entityIdLower.contains(pattern) || friendlyName.contains(pattern)
                                        }
                                        
                                        val isOtherRoom = listOf(
                                            "slaapkamer", "bedroom", "keuken", "kitchen", "badkamer", 
                                            "bathroom", "kantoor", "office", "gang", "hallway", "zolder",
                                            "attic", "kelder", "basement", "garage"
                                        ).any { pattern ->
                                            entityIdLower.contains(pattern) || friendlyName.contains(pattern)
                                        }
                                        
                                        // Assign priority (lower = better)
                                        val priority = when {
                                            isConfiguredEntity -> 0  // Explicitly configured
                                            isSystemSensor -> 100    // System sensors - worst
                                            isOutdoor -> 99          // Outdoor - second worst
                                            isLivingRoom -> 1        // Living room - best
                                            isOtherRoom -> 2         // Other rooms - good
                                            deviceClass == "temperature" -> 3  // Has proper device_class
                                            entityIdLower.startsWith("climate.") -> 4  // Climate entity
                                            else -> 10               // Unknown sensors
                                        }
                                        
                                        tempCandidates.add(Triple(entityId, temp, priority))
                                        android.util.Log.d("ButlerWidget", "Temp candidate: $entityId = $temp (priority $priority, device_class=$deviceClass)")
                                    } catch (e: Exception) {
                                        android.util.Log.w("ButlerWidget", "Failed to parse temp from $entityId: $state")
                                    }
                                }
                                
                                // Energy
                                if (entityIdLower.contains("daily") && entityIdLower.contains("energy") || entityId == energyEntity) {
                                    val unit = attrs?.optString("unit_of_measurement", "kWh") ?: "kWh"
                                    try {
                                        val energy = state.toDouble()
                                        energyValue = "${"%.1f".format(energy)} $unit"
                                    } catch (e: Exception) {}
                                }
                                
                                // Presence (person entities)
                                if (entityId.startsWith("person.") && state == "home") {
                                    val name = attrs?.optString("friendly_name", entityId.replace("person.", "")) 
                                        ?: entityId.replace("person.", "")
                                    presencePeople.add(name)
                                }
                            }
                            
                            // Pick best temperature candidate
                            android.util.Log.d("ButlerWidget", "Total temp candidates: ${tempCandidates.size}")
                            if (tempCandidates.isNotEmpty()) {
                                // Prefer room sensors (priority 0-5) over outdoor (99) and system (100)
                                val roomCandidates = tempCandidates.filter { it.third < 50 }
                                val finalCandidates = if (roomCandidates.isNotEmpty()) roomCandidates else tempCandidates
                                
                                val best = finalCandidates.minByOrNull { it.third }!!
                                tempValue = "${best.second.toInt()}°C"
                                android.util.Log.d("ButlerWidget", "SELECTED: ${best.first} = ${best.second}°C (priority ${best.third})")
                            } else {
                                android.util.Log.w("ButlerWidget", "No temperature candidates found at all!")
                            }
                            
                            val presenceText = when {
                                presencePeople.isEmpty() -> "👤 Nobody home"
                                presencePeople.size == 1 -> "👤 ${presencePeople[0]} home"
                                else -> "👤 ${presencePeople.size} people home"
                            }
                            
                            // Cache and update UI on main thread
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
                            
                        } catch (e: Exception) {
                            android.util.Log.e("ButlerWidget", "Error fetching HA data", e)
                            e.printStackTrace()
                        }
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("ButlerWidget", "Critical error in updateAppWidget", e)
                e.printStackTrace()
            }
        }

        private fun fetchHAStates(url: String, token: String): JSONArray {
            val connection = URL("$url/api/states").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.connectTimeout = 10000
            connection.readTimeout = 10000
            
            val response = connection.inputStream.bufferedReader().readText()
            return JSONArray(response)
        }
    }
}
