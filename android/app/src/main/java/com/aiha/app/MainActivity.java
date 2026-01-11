package com.aiha.app;

import com.getcapacitor.BridgeActivity;
import com.aiha.app.FloatingButtonPlugin;
import com.aiha.app.TimerPlugin;
import android.content.Intent;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    public static boolean pendingVoiceInput = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FloatingButtonPlugin.class);
        registerPlugin(TimerPlugin.class);
        super.onCreate(savedInstanceState);
        checkVoiceIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        checkVoiceIntent(intent);
    }

    private void checkVoiceIntent(Intent intent) {
        if (intent != null && "com.aiha.app.ACTION_VOICE_INPUT".equals(intent.getAction())) {
            pendingVoiceInput = true;
        }
    }
}
