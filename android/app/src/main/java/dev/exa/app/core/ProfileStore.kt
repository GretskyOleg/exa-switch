package dev.exa.app.core

import android.content.Context
import org.json.JSONArray

object ProfileStore {
    private const val PREFS = "exa"
    private const val KEY_PROFILES = "profiles"
    private const val KEY_ACTIVE = "active"
    private const val KEY_AUTO = "autoConnect"

    fun load(context: Context): List<Profile> {
        val raw = prefs(context).getString(KEY_PROFILES, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until minOf(arr.length(), 200)).mapNotNull { i ->
                runCatching { Profile.fromJson(arr.getJSONObject(i)) }.getOrNull()
                    ?.takeIf { it.id.isNotBlank() && it.outboundJson.isNotBlank() && it.link.isNotBlank() }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun save(context: Context, profiles: List<Profile>) {
        val arr = JSONArray()
        profiles.take(200).forEach { arr.put(it.toJson()) }
        prefs(context).edit().putString(KEY_PROFILES, arr.toString()).apply()
    }

    fun add(context: Context, profile: Profile): Boolean {
        val list = load(context).toMutableList()
        if (list.any { it.link == profile.link }) return false
        list.add(profile)
        save(context, list)
        if (activeId(context) == null) setActive(context, profile.id)
        return true
    }

    fun remove(context: Context, id: String) {
        val list = load(context).filterNot { it.id == id }
        save(context, list)
        if (activeId(context) == id) setActive(context, list.firstOrNull()?.id)
    }

    fun active(context: Context): Profile? {
        val id = activeId(context) ?: return null
        return load(context).firstOrNull { it.id == id }
    }

    fun activeId(context: Context): String? = prefs(context).getString(KEY_ACTIVE, null)

    fun setActive(context: Context, id: String?) {
        prefs(context).edit().putString(KEY_ACTIVE, id).apply()
    }

    fun autoConnect(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTO, true)

    fun setAutoConnect(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO, value).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
