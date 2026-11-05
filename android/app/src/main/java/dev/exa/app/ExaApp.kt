package dev.exa.app

import android.app.Application
import libv2ray.Libv2ray

class ExaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            Libv2ray.touch()
            Libv2ray.initCoreEnv(filesDir.absolutePath, "")
        } catch (_: Throwable) {
            // Native library is absent on unsupported ABIs; the UI still opens
            // and reports the error when connecting.
        }
    }
}
