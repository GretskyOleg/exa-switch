package dev.exa.app.core

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.util.UUID

object VlessParser {

    private const val MAX_LINK = 8192
    private val idPattern = Regex("^[A-Za-z0-9._-]{1,64}$")

    fun parseMany(text: String): List<Profile> {
        val decoded = maybeBase64(text)
        val out = ArrayList<Profile>()
        val seen = HashSet<String>()
        decoded.lineSequence().forEach { raw ->
            val line = raw.trim()
            if (!line.startsWith("vless://", ignoreCase = true)) return@forEach
            if (line.length > MAX_LINK) return@forEach
            val profile = runCatching { parse(line) }.getOrNull() ?: return@forEach
            if (seen.add(profile.link)) out.add(profile)
        }
        return out
    }

    fun parse(link: String): Profile? {
        val raw = link.trim()
        if (raw.length > MAX_LINK || !raw.startsWith("vless://", ignoreCase = true)) return null
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        if (!uri.scheme.equals("vless", ignoreCase = true)) return null

        val id = clean(decode(uri.userInfo ?: ""), 64)
        if (!idPattern.matches(id)) return null

        val host = clean((uri.host ?: "").removeSurrounding("[", "]").trimEnd('.'), 255)
        if (host.isEmpty() || Regex("[\\s/\\\\@?#]").containsMatchIn(host)) return null

        val p = query(uri)
        val network = when (val n = first(p, listOf("type", "network"), "tcp").lowercase()) {
            "raw" -> "tcp"
            "websocket" -> "ws"
            "splithttp" -> "xhttp"
            "mkcp" -> "kcp"
            "h2", "http" -> "h2"
            else -> n
        }
        if (network !in setOf("tcp", "ws", "grpc", "xhttp", "httpupgrade", "kcp")) return null

        val security = when (val s = first(p, listOf("security"), "none").lowercase()) {
            "xtls" -> "tls"
            else -> s
        }
        if (security !in setOf("none", "tls", "reality")) return null

        val port = uri.port.takeIf { it in 1..65535 }
            ?: if (security == "none") 80 else 443
        val sni = clean(first(p, listOf("sni", "peer", "servername"), host), 255).ifEmpty { host }
        val fingerprint = clean(first(p, listOf("fp", "fingerprint"), ""), 32)
        val flow = clean(first(p, listOf("flow"), ""), 32)
        if (flow.startsWith("xtls-rprx-direct") || flow.startsWith("xtls-rprx-splice")) return null
        val encryption = clean(first(p, listOf("encryption"), "none"), 32).ifEmpty { "none" }
        val path = clean(first(p, listOf("path"), ""), 1024)
        val hostHeader = clean(first(p, listOf("host"), ""), 255)
        val headerType = clean(first(p, listOf("headerType"), "none"), 16).lowercase()
            .let { if (it == "http") "http" else "none" }
        val serviceName = clean(first(p, listOf("serviceName"), ""), 255)
        val authority = clean(first(p, listOf("authority"), hostHeader), 255)
        val mode = clean(first(p, listOf("mode"), "auto"), 32).ifEmpty { "auto" }
        val packetEncoding = clean(first(p, listOf("packetEncoding"), ""), 32)

        val user = JSONObject().put("id", id).put("encryption", encryption)
        if (flow.isNotEmpty()) user.put("flow", flow)
        if (packetEncoding.isNotEmpty()) user.put("packetEncoding", packetEncoding)

        val stream = JSONObject().put("network", network).put("security", security)
        when (security) {
            "tls" -> {
                val tls = JSONObject().put("serverName", sni)
                if (fingerprint.isNotEmpty()) tls.put("fingerprint", fingerprint)
                val alpn = splitAlpn(first(p, listOf("alpn"), ""))
                if (alpn.isNotEmpty()) tls.put("alpn", JSONArray(alpn))
                val pcs = clean(first(p, listOf("pcs", "pinnedPeerCertSha256"), ""), 128)
                if (pcs.isNotEmpty()) tls.put("pinnedPeerCertSha256", pcs)
                val vcn = clean(first(p, listOf("vcn", "verifyPeerCertByName"), ""), 255)
                if (vcn.isNotEmpty()) tls.put("verifyPeerCertByName", vcn)
                stream.put("tlsSettings", tls)
            }
            "reality" -> {
                val pbk = clean(first(p, listOf("pbk", "publicKey"), ""), 128)
                if (pbk.isEmpty()) return null
                val reality = JSONObject()
                    .put("serverName", sni)
                    .put("fingerprint", fingerprint.ifEmpty { "chrome" })
                    .put("publicKey", pbk)
                    .put("shortId", clean(first(p, listOf("sid", "shortId"), ""), 64))
                    .put("spiderX", clean(first(p, listOf("spx", "spiderX"), "/"), 255).ifEmpty { "/" })
                val pqv = clean(first(p, listOf("pqv", "mldsa65Verify"), ""), 256)
                if (pqv.isNotEmpty()) reality.put("mldsa65Verify", pqv)
                stream.put("realitySettings", reality)
            }
        }

        when (network) {
            "ws" -> {
                val ws = JSONObject().put("path", path.ifEmpty { "/" })
                if (hostHeader.isNotEmpty()) ws.put("headers", JSONObject().put("Host", hostHeader))
                stream.put("wsSettings", ws)
            }
            "httpupgrade" -> {
                val hu = JSONObject().put("path", path.ifEmpty { "/" })
                if (hostHeader.isNotEmpty()) hu.put("host", hostHeader)
                stream.put("httpupgradeSettings", hu)
            }
            "xhttp" -> {
                val xhttp = JSONObject().put("path", path.ifEmpty { "/" }).put("mode", mode)
                if (hostHeader.isNotEmpty()) xhttp.put("host", hostHeader)
                sanitizeExtra(first(p, listOf("extra"), ""))?.let { extra ->
                    extra.keys().forEach { key -> xhttp.put(key, extra.get(key)) }
                }
                stream.put("xhttpSettings", xhttp)
            }
            "grpc" -> {
                val grpc = JSONObject().put("serviceName", serviceName)
                if (authority.isNotEmpty()) grpc.put("authority", authority)
                if (first(p, listOf("mode"), "").equals("multi", ignoreCase = true)) grpc.put("multiMode", true)
                stream.put("grpcSettings", grpc)
            }
            "tcp" -> {
                if (headerType == "http") {
                    val headers = JSONObject()
                    if (hostHeader.isNotEmpty()) headers.put("Host", JSONArray().put(hostHeader))
                    stream.put("tcpSettings", JSONObject().put(
                        "header", JSONObject()
                            .put("type", "http")
                            .put("request", JSONObject()
                                .put("path", JSONArray().put(path.ifEmpty { "/" }))
                                .put("headers", headers))
                    ))
                }
            }
            "kcp" -> {
                val kcp = JSONObject()
                    .put("mtu", clamp(first(p, listOf("mtu"), ""), 1350, 576, 1500))
                    .put("tti", clamp(first(p, listOf("tti"), ""), 50, 10, 255))
                    .put("uplinkCapacity", clamp(first(p, listOf("uplinkCapacity"), ""), 5, 0, 1000))
                    .put("downlinkCapacity", clamp(first(p, listOf("downlinkCapacity"), ""), 20, 0, 1000))
                    .put("congestion", first(p, listOf("congestion"), "").equals("true", ignoreCase = true))
                    .put("readBufferSize", clamp(first(p, listOf("readBufferSize"), ""), 2, 0, 64))
                    .put("writeBufferSize", clamp(first(p, listOf("writeBufferSize"), ""), 2, 0, 64))
                stream.put("kcpSettings", kcp)
            }
        }

        val vnext = JSONObject()
            .put("address", host)
            .put("port", port)
            .put("users", JSONArray().put(user))
        val outbound = JSONObject()
            .put("protocol", "vless")
            .put("settings", JSONObject().put("vnext", JSONArray().put(vnext)))
            .put("streamSettings", stream)

        val name = clean(decode(uri.fragment ?: ""), 80).ifEmpty { "$host:$port" }
        return Profile(
            id = UUID.randomUUID().toString(),
            name = name,
            link = raw,
            host = host,
            port = port,
            security = security,
            network = network,
            outboundJson = outbound.toString()
        )
    }

    private fun maybeBase64(text: String): String {
        val value = text.trim()
        if (value.contains("://")) return value
        if (!Regex("^[A-Za-z0-9+/=_\\-\\s]+$").matches(value)) return value
        return runCatching {
            val normalized = value.replace('-', '+').replace('_', '/')
            String(Base64.decode(normalized, Base64.DEFAULT), Charsets.UTF_8)
        }.getOrNull()?.takeIf { it.contains("://") } ?: value
    }

    private fun query(uri: URI): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        uri.rawQuery?.split('&')?.forEach { part ->
            if (part.isBlank()) return@forEach
            val at = part.indexOf('=')
            val key = if (at >= 0) part.substring(0, at) else part
            val value = if (at >= 0) part.substring(at + 1) else ""
            out[decode(key).lowercase()] = decode(value)
        }
        return out
    }

    private fun first(p: Map<String, String>, names: List<String>, fallback: String): String {
        names.forEach { name ->
            p[name]?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        return fallback
    }

    private fun decode(value: String): String =
        runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)

    private fun clean(value: String, max: Int): String =
        value.replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim().take(max)

    private fun splitAlpn(value: String): List<String> =
        value.split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(8)

    private fun clamp(value: String, fallback: Int, min: Int, max: Int): Int =
        (value.toIntOrNull() ?: fallback).coerceIn(min, max)

    /** Only flat primitives are copied from `extra`; nested JSON must never
     *  reach xray stream settings. */
    private fun sanitizeExtra(value: String): JSONObject? {
        if (value.isBlank() || value.length > 4096) return null
        val parsed = runCatching { JSONObject(value) }.getOrNull() ?: return null
        val out = JSONObject()
        var count = 0
        parsed.keys().forEach { key ->
            if (count >= 20 || !Regex("^[A-Za-z][A-Za-z0-9_]{0,31}$").matches(key)) return@forEach
            val v = parsed.opt(key)
            when (v) {
                is String -> out.put(key, clean(v, 256))
                is Number -> out.put(key, v)
                is Boolean -> out.put(key, v)
                else -> return@forEach
            }
            count++
        }
        return if (count > 0) out else null
    }
}
