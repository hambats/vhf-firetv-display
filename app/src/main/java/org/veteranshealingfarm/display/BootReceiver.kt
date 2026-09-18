package org.veteranshealingfarm.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the display back after the television is powered on again.
 *
 * Fire OS does not guarantee this — some Fire TV builds hold BOOT_COMPLETED back from
 * sideloaded apps, and the launcher may win the race regardless. It costs one class and
 * recovers the common case, so it is worth having; docs/DISPLAY_SETUP.md carries the
 * manual fallback for when it does not fire.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) return

        context.startActivity(
            Intent(context, DisplayActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
