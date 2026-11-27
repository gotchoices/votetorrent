package org.votetorrent.attestationnative

import androidx.core.content.FileProvider

/**
 * A dedicated subclass of [FileProvider] rather than FileProvider itself: declaring the stock
 * `androidx.core.content.FileProvider` class in this library's manifest would collide in the
 * manifest merger with any other library (or the app) that declares it. A uniquely named subclass
 * with its own authority (`<applicationId>.vtfileshare`) merges cleanly. Only `cacheDir/vt-share/`
 * is exposed (see res/xml/vt_file_share_paths.xml).
 */
class VtFileShareProvider : FileProvider()
