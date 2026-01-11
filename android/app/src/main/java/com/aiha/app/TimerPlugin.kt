package com.aiha.app

import android.content.Intent
import android.provider.AlarmClock
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "TimerPlugin")
class TimerPlugin : Plugin() {

    @PluginMethod
    fun setTimer(call: PluginCall) {
        val seconds = call.getInt("seconds", 60) ?: 60
        val message = call.getString("message", "Timer") ?: "Timer"

        try {
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                putExtra(AlarmClock.EXTRA_MESSAGE, message)
                putExtra(AlarmClock.EXTRA_SKIP_UI, false) // Show the timer UI
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to set timer: ${e.message}")
        }
    }

    @PluginMethod
    fun setAlarm(call: PluginCall) {
        val hour = call.getInt("hour", 7) ?: 7
        val minute = call.getInt("minute", 0) ?: 0
        val message = call.getString("message", "Alarm") ?: "Alarm"
        val daysArray = call.getArray("days") // Optional: recurring days

        try {
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hour)
                putExtra(AlarmClock.EXTRA_MINUTES, minute)
                putExtra(AlarmClock.EXTRA_MESSAGE, message)
                putExtra(AlarmClock.EXTRA_SKIP_UI, false) // Show the alarm UI
                putExtra(AlarmClock.EXTRA_VIBRATE, true)
                
                // Handle recurring days if provided
                if (daysArray != null && daysArray.length() > 0) {
                    val days = ArrayList<Int>()
                    for (i in 0 until daysArray.length()) {
                        days.add(daysArray.getInt(i))
                    }
                    putExtra(AlarmClock.EXTRA_DAYS, days)
                }
                
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to set alarm: ${e.message}")
        }
    }
}
