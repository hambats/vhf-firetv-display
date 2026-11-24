package org.veteranshealingfarm.display

import android.content.Intent
import android.view.Display
import android.view.KeyEvent

/**
 * The shell's decisions about the shared television, kept free of Android objects so they
 * can be unit-tested on the JVM (app/src/test). Only compile-time constants are used here.
 *
 * The rule behind every answer: this TV belongs to residents after hours. The display never
 * brings itself forward, never switches the panel on, and never takes a key a resident needs.
 */
object KeyPolicy {

    enum class Down {
        /** Consume the press and track it, so holding it can reach [onLongPress]. */
        TRACK,
        /** Hand the key to the system (volume, mute, power, media, HOME, D-pad...). */
        PASS,
    }

    /**
     * Only BACK is ours: a short press must not leave the display by accident (the system
     * default would finish the activity). Every other key goes to the system untouched.
     */
    fun onDown(keyCode: Int): Down =
        if (keyCode == KeyEvent.KEYCODE_BACK) Down.TRACK else Down.PASS

    /** True when a long press should step the display aside (moveTaskToBack, never finish). */
    fun onLongPress(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_BACK

    /**
     * True when the release should be consumed and do nothing. For BACK that is both the
     * short press and the release after a long press; consuming it is what keeps the system
     * from calling onBackPressed() and closing the display.
     */
    fun consumeUp(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_BACK
}

object BootGate {

    /**
     * Whether a broadcast at boot may start the display. Only the system's BOOT_COMPLETED,
     * and only when the television is already on: the device is interactive and the panel
     * reports STATE_ON. A set that boots into standby (say, power restored at 2 a.m.) stays
     * dark; the display appears the next time someone opens it. Anything uncertain (an
     * unknown display state) counts as "not on".
     */
    fun shouldStartDisplay(action: String?, interactive: Boolean, displayState: Int): Boolean =
        action == Intent.ACTION_BOOT_COMPLETED && interactive && displayState == Display.STATE_ON
}
