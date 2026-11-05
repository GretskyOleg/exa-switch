package dev.exa.app.core

import android.content.Context
import hev.htproxy.TProxyService
import java.io.File

object HevTunnel {
    private var running = false

    @Synchronized
    fun start(context: Context, tunFd: Int, socksPort: Int): Boolean {
        stop()
        val config = File(context.filesDir, "hev.yaml")
        config.writeText(
            """
            tunnel:
              mtu: 1500
            socks5:
              port: $socksPort
              address: 127.0.0.1
              udp: 'udp'
            """.trimIndent()
        )
        running = try {
            TProxyService.TProxyStartService(config.absolutePath, tunFd)
        } catch (t: Throwable) {
            VpnLog.add("hev: ${t.message ?: t.javaClass.simpleName}")
            false
        }
        VpnLog.add(if (running) "hev: started" else "hev: failed to start")
        return running
    }

    @Synchronized
    fun stop() {
        if (running) {
            try {
                TProxyService.TProxyStopService()
            } catch (_: Throwable) {
            }
            running = false
        }
    }

    fun isRunning(): Boolean = running

    fun stats(): LongArray? = try {
        TProxyService.TProxyGetStats()
    } catch (_: Throwable) {
        null
    }
}
