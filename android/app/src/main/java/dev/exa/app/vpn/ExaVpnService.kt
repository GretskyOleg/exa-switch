package dev.exa.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.exa.app.MainActivity
import dev.exa.app.R
import dev.exa.app.core.HevTunnel
import dev.exa.app.core.Profile
import dev.exa.app.core.ProfileStore
import dev.exa.app.core.VpnController
import dev.exa.app.core.VpnLog
import dev.exa.app.core.XrayBridge
import dev.exa.app.core.XrayConfig
import org.json.JSONObject

class ExaVpnService : VpnService() {
    companion object {
        const val ACTION_START = "dev.exa.app.action.START"
        const val ACTION_STOP = "dev.exa.app.action.STOP"
        const val EXTRA_PROFILE = "profile"
        private const val CHANNEL_ID = "exa_vpn"
        private const val NOTIFICATION_ID = 7
    }

    private var tun: ParcelFileDescriptor? = null
    private var running = false
    private var active: Profile? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopVpn()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val profile = intent.getStringExtra(EXTRA_PROFILE)?.let { raw ->
                    runCatching { Profile.fromJson(JSONObject(raw)) }.getOrNull()
                } ?: ProfileStore.active(this)
                if (profile != null) startVpn(profile) else stopVpn()
            }
            else -> {
                val profile = ProfileStore.active(this)
                if (profile != null) startVpn(profile) else stopVpn()
            }
        }
        return START_STICKY
    }

    private fun startVpn(profile: Profile) {
        stopVpn(stopService = false)
        active = profile
        createChannel()
        startForegroundCompat(notification("Подключение…", profile.name))
        VpnController.setConnecting(profile)

        try {
            val builder = Builder()
                .setSession("EXA")
                .setMtu(1500)
                .addAddress("10.111.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addAddress("fd00:111::2", 128)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("2606:4700:4700::1111")
                .setBlocking(false)

            // The app's own xray upstream must bypass the TUN, otherwise it loops.
            runCatching { builder.addDisallowedApplication(packageName) }
                .onFailure { VpnLog.add("vpn: disallow app failed: ${it.message}") }

            val fd = builder.establish() ?: error("VPN permission denied")
            tun = fd

            val error = XrayBridge.start(XrayConfig.build(profile))
            if (error != null) error("xray: $error")

            if (!HevTunnel.start(this, fd.fd, XrayConfig.SOCKS_PORT)) {
                error("hev tunnel failed")
            }

            running = true
            VpnController.setConnected(profile)
            notify(notification("Подключено", profile.name))
            VpnLog.add("vpn: connected ${profile.name} (${profile.host}:${profile.port})")
        } catch (t: Throwable) {
            VpnLog.add("vpn: ${t.message ?: t.javaClass.simpleName}")
            stopVpn()
            VpnController.setError(t.message ?: "Не удалось подключиться")
        }
    }

    private fun stopVpn(stopService: Boolean = true) {
        HevTunnel.stop()
        XrayBridge.stop()
        runCatching { tun?.close() }
        tun = null
        running = false
        active = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        VpnController.setDisconnected()
        VpnLog.add("vpn: stopped")
        if (stopService) stopSelf()
    }

    override fun onRevoke() {
        VpnLog.add("vpn: revoked by system")
        stopVpn()
        super.onRevoke()
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    private fun startForegroundCompat(n: Notification) {
        val type = if (Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(title: String, profileName: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_exa)
            .setContentTitle("EXA — $title")
            .setContentText(profileName)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .build()
    }

    private fun notify(n: Notification) {
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        }
    }
}
