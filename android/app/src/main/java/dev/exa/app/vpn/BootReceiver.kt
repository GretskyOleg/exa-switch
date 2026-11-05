package dev.exa.app.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import dev.exa.app.core.ProfileStore
import dev.exa.app.core.VpnController
import dev.exa.app.core.VpnLog

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!ProfileStore.autoConnect(context)) return
        val profile = ProfileStore.active(context) ?: return
        // Only auto-start if the user already granted VPN consent.
        if (VpnService.prepare(context) != null) return
        VpnLog.add("boot: auto-connect ${profile.name}")
        VpnController.start(context, profile)
    }
}
