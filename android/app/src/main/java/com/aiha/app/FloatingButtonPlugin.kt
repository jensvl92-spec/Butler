package com.aiha.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Native plugin to control the floating button service from React/Capacitor.
 */
@CapacitorPlugin(name = "FloatingButton")
class FloatingButtonPlugin : Plugin() {
    
    @PluginMethod
    fun start(call: PluginCall) {
        val context = activity
        
        // Check overlay permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            // Request permission
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}")
            )
            context.startActivity(intent)
            call.reject("Overlay permission required. Please grant and try again.")
            return
        }
        
        // Start the floating button service (as foreground service on O+)
        val serviceIntent = Intent(context, FloatingButtonService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
        
        call.resolve(JSObject().put("started", true))
    }
    
    @PluginMethod
    fun stop(call: PluginCall) {
        val context = activity
        val serviceIntent = Intent(context, FloatingButtonService::class.java)
        context.stopService(serviceIntent)
        
        call.resolve(JSObject().put("stopped", true))
    }
    
    @PluginMethod
    fun hasOverlayPermission(call: PluginCall) {
        val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(activity)
        } else {
            true
        }
        call.resolve(JSObject().put("hasPermission", hasPermission))
    }
    
    @PluginMethod
    fun requestOverlayPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${activity.packageName}")
            )
            activity.startActivity(intent)
        }
        call.resolve()
    }
    
    @PluginMethod
    fun checkPendingVoiceInput(call: PluginCall) {
        val pending = MainActivity.pendingVoiceInput
        // Clear the flag after reading
        MainActivity.pendingVoiceInput = false
        call.resolve(JSObject().put("pending", pending))
    }
}
