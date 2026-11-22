package com.aiha.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Floating Button Service
 * Creates a chat-head style floating mic button that stays on top of all apps.
 * Android 14+ foreground service compliant with overlay permission guards.
 */
class FloatingButtonService : Service() {

    private var windowManager: WindowManager? = null
    private var floatingView: View? = null
    private var params: WindowManager.LayoutParams? = null
    private var viewAttached = false

    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Start foreground immediately with Android 14+ specialUse type
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Guard against missing SYSTEM_ALERT_WINDOW permission (prevents BadTokenException crash)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            android.util.Log.w("FloatingButtonService", "Overlay permission not granted; stopping service.")
            stopSelf()
            return START_NOT_STICKY
        }

        attachOverlayIfNeeded()
        return START_STICKY
    }

    private fun attachOverlayIfNeeded() {
        if (viewAttached) return

        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        floatingView = LayoutInflater.from(this).inflate(R.layout.floating_button, null)

        val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 100
        }

        try {
            windowManager?.addView(floatingView, params)
            viewAttached = true
        } catch (e: Exception) {
            android.util.Log.e("FloatingButtonService", "Failed to add overlay view", e)
            viewAttached = false
            stopSelf()
            return
        }

        floatingView?.setOnTouchListener { _, event ->
            val currentParams = params ?: return@setOnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = currentParams.x
                    initialY = currentParams.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    currentParams.x = initialX + (event.rawX - initialTouchX).toInt()
                    currentParams.y = initialY + (event.rawY - initialTouchY).toInt()
                    if (viewAttached) {
                        try {
                            windowManager?.updateViewLayout(floatingView, currentParams)
                        } catch (_: Exception) {}
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val deltaX = Math.abs(event.rawX - initialTouchX)
                    val deltaY = Math.abs(event.rawY - initialTouchY)
                    if (deltaX < 10 && deltaY < 10) {
                        openButlerWithVoice()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun openButlerWithVoice() {
        val intent = Intent(this, MainActivity::class.java).apply {
            action = "com.aiha.app.ACTION_VOICE_INPUT"
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Butler Floating Button",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the floating mic button active"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Butler Actief")
            .setContentText("Tik op de zwevende knop voor spraakcommando's")
            .setSmallIcon(R.drawable.ic_mic)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (viewAttached) {
            floatingView?.let {
                try {
                    windowManager?.removeView(it)
                } catch (_: Exception) {}
            }
            viewAttached = false
        }
        floatingView = null
    }

    companion object {
        const val ACTION_START = "com.aiha.app.START_FLOATING"
        const val ACTION_STOP = "com.aiha.app.STOP_FLOATING"
        private const val CHANNEL_ID = "butler_floating_button"
        private const val NOTIFICATION_ID = 1001
    }
}
