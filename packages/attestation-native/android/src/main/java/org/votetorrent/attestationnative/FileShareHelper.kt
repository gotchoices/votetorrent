package org.votetorrent.attestationnative

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/** A failure carrying one of the closed reject codes: INVALID_NAME, WRITE_FAILED, SHARE_FAILED. */
class FileShareException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Plan 62-75 (D-36): cache-file write + file share intent. Files live ONLY in `cacheDir/vt-share`,
 * the single directory the private [VtFileShareProvider] exposes.
 */
object FileShareHelper {
	private const val SHARE_DIR = "vt-share"
	private val NAME_PATTERN = Regex("^[A-Za-z0-9._-]{1,100}$")

	private fun shareDir(context: Context): File = File(context.cacheDir, SHARE_DIR)

	fun writeShareFile(context: Context, fileName: String, contents: String): Uri {
		if (!NAME_PATTERN.matches(fileName) || fileName.contains("..")) {
			throw FileShareException("INVALID_NAME", "file name must match [A-Za-z0-9._-]{1,100} and not contain '..'")
		}
		try {
			val dir = shareDir(context)
			if (!dir.exists() && !dir.mkdirs()) throw java.io.IOException("could not create ${dir.path}")
			dir.listFiles()?.forEach { it.delete() }
			val file = File(dir, fileName)
			file.writeText(contents, Charsets.UTF_8)
			return Uri.fromFile(file)
		} catch (e: FileShareException) {
			throw e
		} catch (e: Exception) {
			throw FileShareException("WRITE_FAILED", e.message ?: "write failed", e)
		}
	}

	/**
	 * Deletes the regular file at [uriString] iff its canonical path is a strict child of the canonical
	 * cache directory. Returns whether a file was deleted. Rejects OUTSIDE_CACHE / DELETE_FAILED.
	 */
	fun deleteCachedFile(context: Context, uriString: String): Boolean {
		try {
			val path = Uri.parse(uriString).path
			if (uriString.isEmpty() || path.isNullOrEmpty()) {
				throw FileShareException("OUTSIDE_CACHE", "uri has no path")
			}
			val file = File(path).canonicalFile
			val root = context.cacheDir.canonicalFile
			if (!file.path.startsWith(root.path + File.separator) || !file.isFile) {
				throw FileShareException("OUTSIDE_CACHE", "file is not a regular file inside the cache directory")
			}
			return file.delete()
		} catch (e: FileShareException) {
			throw e
		} catch (e: Exception) {
			throw FileShareException("DELETE_FAILED", e.message ?: "delete failed", e)
		}
	}

	fun shareFile(
		activity: Activity?,
		context: Context,
		uriString: String,
		mimeType: String,
		subject: String,
		dialogTitle: String,
	) {
		try {
			val path = Uri.parse(uriString).path ?: throw FileShareException("SHARE_FAILED", "uri has no path")
			val file = File(path).canonicalFile
			val root = shareDir(context).canonicalFile
			if (!file.path.startsWith(root.path + File.separator) || !file.isFile) {
				throw FileShareException("SHARE_FAILED", "file is not inside the share directory")
			}
			val contentUri = FileProvider.getUriForFile(context, context.packageName + ".vtfileshare", file)
			val send = Intent(Intent.ACTION_SEND).apply {
				type = mimeType
				putExtra(Intent.EXTRA_STREAM, contentUri)
				putExtra(Intent.EXTRA_SUBJECT, subject)
				clipData = ClipData.newRawUri(subject, contentUri)
				addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
			}
			val chooser = Intent.createChooser(send, dialogTitle)
			if (activity != null) {
				activity.startActivity(chooser)
			} else {
				chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
				context.startActivity(chooser)
			}
		} catch (e: FileShareException) {
			throw e
		} catch (e: Exception) {
			throw FileShareException("SHARE_FAILED", e.message ?: "share failed", e)
		}
	}
}
