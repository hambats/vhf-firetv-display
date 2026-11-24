package org.veteranshealingfarm.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.os.PowerManager
import android.util.Log
import android.view.Display

/**
 * Brings the display back after the television boots, but only if the television is on.
 *
 * This is the single place the app ever starts itself, and it never switches the panel on:
 * if the set boots into standby, nothing happens (see [BootGate]). Fire OS does not guarantee
 * delivery to sideloaded apps, and the launcher may win the race; docs/DISPLAY_SETUP.md
 * carries the manual fallback.
 *
 * Declared non-exported for BOOT_COMPLETED only: that broadcast is protected (only the system
 * can send it) and the system's broadcasts still reach non-exported receivers, so no other
 * app on the television can use this receiver to pull the display to the front.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val interactive = context.getSystemService(PowerManager::class.java)?.isInteractive == true
        val displayState = context.getSystemService(DisplayManager::class.java)
            ?.getDisplay(Display.DEFAULT_DISPLAY)?.state ?: Display.STATE_UNKNOWN

        if (!BootGate.shouldStartDisplay(intent.action, interactive, displayState)) {
            Log.i(
                TAG,
                "boot: not starting the display (action=${intent.action} interactive=$interactive " +
                    "displayState=$displayState); it appears when someone next opens it"
            )
            return
        }
        Log.i(TAG, "boot: television is on; starting the display")
        context.startActivity(
            Intent(context, DisplayActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    private companion object {
        const val TAG = "VhfDisplay"
    }
}
