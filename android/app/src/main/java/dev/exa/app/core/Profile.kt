package dev.exa.app.core

import org.json.JSONObject

data class Profile(
    val id: String,
    val name: String,
    val link: String,
    val host: String,
    val port: Int,
    val security: String,
    val network: String,
    val outboundJson: String
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("link", link)
        .put("host", host)
        .put("port", port)
        .put("security", security)
        .put("network", network)
        .put("outbound", outboundJson)

    companion object {
        fun fromJson(o: JSONObject) = Profile(
            id = o.optString("id"),
            name = o.optString("name"),
            link = o.optString("link"),
            host = o.optString("host"),
            port = o.optInt("port"),
            security = o.optString("security", "none"),
            network = o.optString("network", "tcp"),
            outboundJson = o.optString("outbound")
        )
    }
}
