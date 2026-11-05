package dev.exa.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

object SubscriptionFetcher {
    private const val MAX_BYTES = 2 * 1024 * 1024

    /** HTTPS only: the app does not enable cleartext traffic. */
    suspend fun fetch(url: String): String = withContext(Dispatchers.IO) {
        val parsed = URL(url)
        if (parsed.protocol != "https") {
            throw IOException("Нужен https:// URL подписки")
        }
        val conn = parsed.openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 20000
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("Accept", "text/plain, */*")
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IOException("Подписка вернула HTTP $code")
            val out = ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val buf = ByteArray(8192)
                while (true) {
                    val read = input.read(buf)
                    if (read < 0) break
                    if (out.size() + read > MAX_BYTES) throw IOException("Подписка больше 2 МБ")
                    out.write(buf, 0, read)
                }
            }
            out.toString(Charsets.UTF_8.name())
        } finally {
            conn.disconnect()
        }
    }
}
