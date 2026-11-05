package dev.exa.app.core

import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray

object XrayBridge {
    private var controller: CoreController? = null

    private val handler = object : CoreCallbackHandler {
        override fun startup(): Long {
            VpnLog.add("core: started")
            return 0
        }

        override fun shutdown(): Long {
            VpnLog.add("core: stopped")
            return 0
        }

        override fun onEmitStatus(code: Long, message: String?): Long {
            if (!message.isNullOrBlank()) VpnLog.add("core: $message")
            return 0
        }
    }

    @Synchronized
    fun start(config: String): String? {
        stop()
        return try {
            val c = Libv2ray.newCoreController(handler)
            c.startLoop(config, 0)
            controller = c
            null
        } catch (t: Throwable) {
            VpnLog.add("xray: ${t.message ?: t.javaClass.simpleName}")
            t.message ?: "xray error"
        }
    }

    @Synchronized
    fun stop() {
        try {
            controller?.stopLoop()
        } catch (_: Throwable) {
        }
        controller = null
    }

    fun version(): String = try {
        Libv2ray.checkVersionX()
    } catch (_: Throwable) {
        "unknown"
    }
}
